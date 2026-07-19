use crate::setup::ffmpeg_location;
use crate::youtube_cookies::{
    absorb_rotations, create_snapshot, has_configured_file, record_verification, CookieSnapshot,
    VerificationOutcome, YouTubeCookieStatus,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub duration_sec: f64,
    pub thumbnail: Option<String>,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub video_id: String,
    pub file_path: String,
    /// YouTube's own music credits, when the video has them (None otherwise).
    pub track: Option<String>,
    pub artist: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    video_id: String,
    percent: f64,
    status: String,
}

enum VerificationProbe {
    Verified,
    Rejected,
    Transient(String),
}

fn classify_verification_probe(success: bool, stdout: &str, stderr: &str) -> VerificationProbe {
    let lower = stderr.to_ascii_lowercase();
    let rejected = [
        "login details are needed",
        "you must be logged in",
        "you need to log in",
        "cookies are no longer valid",
        "sign in to confirm you’re not a bot",
        "sign in to confirm you're not a bot",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if rejected {
        return VerificationProbe::Rejected;
    }
    if success
        && serde_json::from_str::<serde_json::Value>(stdout).is_ok_and(|value| {
            value.get("_type").and_then(|v| v.as_str()) == Some("playlist")
                && value.get("id").and_then(|v| v.as_str()) == Some("WL")
                && value.get("extractor_key").and_then(|v| v.as_str()) == Some("YoutubeTab")
        })
    {
        return VerificationProbe::Verified;
    }
    let message = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("YouTube verification returned an unexpected response.");
    VerificationProbe::Transient(message.chars().take(500).collect())
}

pub(crate) fn deno_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        for path in [
            resources.join("deno.exe"),
            resources.join("resources/deno.exe"),
        ] {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/deno.exe");
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn youtube_args(app: &AppHandle, args: Vec<String>) -> Result<Vec<String>, String> {
    let deno = deno_path(app).ok_or_else(|| {
        "The bundled YouTube JavaScript runtime is missing. Reinstall the app to restore Deno."
            .to_string()
    })?;
    // PO token support is strictly additive: None until the bundled token
    // server has answered its health check (or forever, if it failed to
    // start), in which case yt-dlp runs exactly as it did without it.
    let pot = app
        .try_state::<crate::bgutil::PotProvider>()
        .and_then(|provider| provider.args());
    Ok(youtube_args_with_deno(&deno, pot.as_ref(), args))
}

fn youtube_args_with_deno(
    deno: &Path,
    pot: Option<&crate::bgutil::PotArgs>,
    args: Vec<String>,
) -> Vec<String> {
    let mut prefixed = Vec::with_capacity(args.len() + 7);
    prefixed.push("--ignore-config".into());
    prefixed.push("--js-runtimes".into());
    prefixed.push(format!("deno:{}", deno.to_string_lossy()));
    if let Some(pot) = pot {
        prefixed.push("--plugin-dirs".into());
        prefixed.push(pot.plugin_dir.to_string_lossy().to_string());
        prefixed.push("--extractor-args".into());
        prefixed.push(format!("youtubepot-bgutilhttp:base_url={}", pot.base_url));
    }
    prefixed.extend(args);
    prefixed
}

fn authenticated_args(
    app: &AppHandle,
    args: Vec<String>,
) -> Result<(Vec<String>, Option<CookieSnapshot>), String> {
    let snapshot = create_snapshot(app)?;
    let args = if let Some(cookie_file) = &snapshot {
        let mut authenticated = Vec::with_capacity(args.len() + 2);
        authenticated.push("--cookies".into());
        authenticated.push(cookie_file.path().to_string_lossy().to_string());
        authenticated.extend(args);
        authenticated
    } else {
        args
    };
    Ok((youtube_args(app, args)?, snapshot))
}

/// After a cookie-authenticated yt-dlp run finishes, fold any cookie values
/// YouTube rotated during the run back into the managed store (yt-dlp rewrites
/// the --cookies file it was given on exit). Best-effort: a failure here must
/// never break the command whose result we already have.
fn absorb_cookie_rotations(app: &AppHandle, snapshot: &Option<CookieSnapshot>) {
    if let Some(snapshot) = snapshot {
        let _ = absorb_rotations(app, snapshot);
    }
}

/// Bound every network read so a stalled YouTube connection fails with an
/// error instead of hanging the UI forever, and cap yt-dlp's own retry loops
/// on the interactive (metadata / stream-resolve) paths where failing fast
/// beats waiting out ten retry rounds.
fn interactive_network_args(args: &mut Vec<String>) {
    for flag in [
        "--socket-timeout",
        "15",
        "--retries",
        "2",
        "--extractor-retries",
        "2",
    ] {
        args.push(flag.into());
    }
}

fn is_auth_failure(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    [
        "sign in to confirm you’re not a bot",
        "sign in to confirm you're not a bot",
        "login required",
        "cookies are no longer valid",
        "authentication",
        "confirm your age",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn sanitize_diagnostic(app: &AppHandle, raw: &str, fallback: &str) -> String {
    let mut message = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join(" ");
    if let Ok(dir) = crate::youtube_cookies::auth_dir(app) {
        message = message.replace(
            &dir.to_string_lossy().to_string(),
            "[private auth directory]",
        );
    }
    if message.is_empty() {
        fallback.into()
    } else {
        message.chars().take(700).collect()
    }
}

fn sanitize_ytdlp_error(app: &AppHandle, raw: &str, fallback: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("signature solving failed")
        || lower.contains("n challenge solving failed")
        || lower.contains("only images are available")
    {
        return "YouTube's stream challenge could not be solved. Update yt-dlp from Settings; if it still fails, reinstall the app to restore the bundled JavaScript runtime."
            .into();
    }
    if is_auth_failure(raw) {
        return if has_configured_file(app) {
            "YouTube rejected the saved cookies. Sign in to YouTube, export a fresh Cookie-Editor JSON or Netscape cookies.txt file, and choose Update from the cookie button."
                .into()
        } else {
            "YouTube requires sign-in verification. Export cookies while signed in to YouTube, then import the JSON or cookies.txt file from the cookie button in the title bar."
                .into()
        };
    }

    sanitize_diagnostic(app, raw, fallback)
}

#[tauri::command]
pub async fn verify_youtube_cookies(app: AppHandle) -> Result<YouTubeCookieStatus, String> {
    let snapshot = create_snapshot(&app)?
        .ok_or_else(|| "Import YouTube cookies before verifying them.".to_string())?;
    let generation = snapshot.generation().to_string();
    let args = youtube_args(
        &app,
        vec![
            "--cookies".into(),
            snapshot.path().to_string_lossy().to_string(),
            "--flat-playlist".into(),
            "--playlist-end".into(),
            "1".into(),
            "--skip-download".into(),
            "--dump-single-json".into(),
            "--socket-timeout".into(),
            "15".into(),
            "--extractor-retries".into(),
            "1".into(),
            ":ytwatchlater".into(),
        ],
    )?;
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    // The probe hit YouTube with the cookies, so it may have rotated them —
    // keep those fresh values (same generation, so the verdict stays tied).
    let _ = absorb_rotations(&app, &snapshot);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    match classify_verification_probe(output.status.success(), &stdout, &stderr) {
        VerificationProbe::Verified => {
            record_verification(&app, &generation, VerificationOutcome::Verified)
        }
        VerificationProbe::Rejected => {
            record_verification(&app, &generation, VerificationOutcome::Rejected)
        }
        VerificationProbe::Transient(raw) => Err(sanitize_diagnostic(
            &app,
            &raw,
            "YouTube verification failed. Check your connection and retry.",
        )),
    }
}

/// Bundled yt-dlp version (smoke test / settings display).
#[tauri::command]
pub async fn ytdlp_version(app: AppHandle) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .arg("--version")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Search YouTube (or resolve a pasted URL) and return lightweight metadata.
#[tauri::command]
pub async fn search(app: AppHandle, query: String) -> Result<Vec<SearchResult>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let is_url = query.starts_with("http://") || query.starts_with("https://");
    let target = if is_url {
        query.clone()
    } else {
        format!("ytsearch20:{query}")
    };

    let mut args: Vec<String> = vec![
        "--dump-json".into(),
        "--flat-playlist".into(),
        "--no-warnings".into(),
        "--ignore-errors".into(),
    ];
    if is_url {
        args.push("--no-playlist".into());
    }
    interactive_network_args(&mut args);
    args.push(target);

    let (args, cookie_snapshot) = authenticated_args(&app, args)?;
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    absorb_cookie_rotations(&app, &cookie_snapshot);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(r) = entry_to_result(&v) {
                results.push(r);
            }
        }
    }

    if results.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() || is_auth_failure(&err) {
            return Err(sanitize_ytdlp_error(&app, &err, "No results"));
        }
    }
    Ok(results)
}

/// Fetch the YouTube "Mix" (RD radio) continuations for a seed video.
/// Returns lightweight metadata, same shape as `search`. Skips the seed itself.
#[tauri::command]
pub async fn related_mix(
    app: AppHandle,
    video_id: String,
    limit: u32,
) -> Result<Vec<SearchResult>, String> {
    let id = video_id.trim();
    if id.is_empty() {
        return Ok(vec![]);
    }
    let mix_url = format!("https://www.youtube.com/watch?v={id}&list=RD{id}");
    let end = (limit + 1).clamp(2, 50); // +1 because start=2 skips the seed

    let mut args: Vec<String> = vec![
        "--dump-json".into(),
        "--flat-playlist".into(),
        "--no-warnings".into(),
        "--ignore-errors".into(),
        "--playlist-start".into(),
        "2".into(), // skip the seed (item 1 is the seed itself)
        "--playlist-end".into(),
        end.to_string(),
    ];
    interactive_network_args(&mut args);
    args.push(mix_url);

    let (args, cookie_snapshot) = authenticated_args(&app, args)?;
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    absorb_cookie_rotations(&app, &cookie_snapshot);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            // A dead/empty mix can echo only the seed back; never return it.
            if let Some(r) = entry_to_result(&v) {
                if r.video_id != id {
                    results.push(r);
                }
            }
        }
    }
    // Distinguish a clean-empty mix (genuinely dead/obscure seed — a valid
    // outcome the caller blacklists) from a failed exit (throttle / 429 / bot
    // check). On a non-zero exit with nothing parsed, surface an error so the
    // JS catch{} treats it as transient and leaves the seed eligible to retry,
    // rather than permanently marking a merely-throttled seed dead. Mirrors
    // `search`'s `results.is_empty() && !status.success()` branch.
    if results.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() || is_auth_failure(&err) {
            return Err(sanitize_ytdlp_error(
                &app,
                &err,
                "Related songs could not be loaded.",
            ));
        }
    }
    Ok(results)
}

fn entry_to_result(v: &serde_json::Value) -> Option<SearchResult> {
    let id = v.get("id")?.as_str()?.to_string();
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("Unknown title")
        .to_string();
    let artist = v
        .get("uploader")
        .or_else(|| v.get("channel"))
        .or_else(|| v.get("uploader_id"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let duration_sec = v.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let thumbnail = best_thumbnail(v);
    let url = format!("https://www.youtube.com/watch?v={id}");
    Some(SearchResult {
        video_id: id,
        title,
        artist,
        duration_sec,
        thumbnail,
        url,
    })
}

fn best_thumbnail(v: &serde_json::Value) -> Option<String> {
    if let Some(t) = v.get("thumbnail").and_then(|x| x.as_str()) {
        return Some(t.to_string());
    }
    let arr = v.get("thumbnails")?.as_array()?;
    arr.iter()
        .rev()
        .find_map(|t| t.get("url").and_then(|u| u.as_str()))
        .map(|s| s.to_string())
}

/// One yt-dlp -g run. Returns the stream URL, or the RAW stderr on failure
/// (callers sanitize before surfacing).
async fn run_stream_resolve(app: &AppHandle, args: Vec<String>) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        let stream = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if stream.is_empty() {
            Err("No stream URL returned".into())
        } else {
            Ok(stream)
        }
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Hand the webview a loopback proxy URL, never the raw googlevideo one — the
/// CDN's no-Range redirect trips the webview's opaque response blocker and the
/// track silently fails (see stream_proxy.rs).
fn proxied_stream_url(app: &AppHandle, stream: String) -> String {
    match app.try_state::<crate::stream_proxy::StreamProxy>() {
        Some(proxy) => proxy.register(&stream),
        None => stream,
    }
}

/// Resolve a direct audio stream URL for "play directly" (ephemeral, no download).
///
/// Deliberately resolves WITHOUT the saved cookies first: stream URLs minted
/// under a signed-in session are refused by the CDN (403) unless the fetch
/// carries a proof-of-origin token, which an audio element cannot provide —
/// so an authenticated resolve "succeeds" and then silently never plays.
/// Anonymous URLs fetch cleanly. Cookies remain the fallback for videos the
/// anonymous path cannot extract at all (age-restricted, bot-check walls).
#[tauri::command]
pub async fn resolve_stream(app: AppHandle, url: String) -> Result<String, String> {
    let mut base_args = vec![
        "-f".into(),
        "bestaudio[ext=m4a]/bestaudio".into(),
        "-g".into(),
        "--no-playlist".into(),
    ];
    interactive_network_args(&mut base_args);
    base_args.push(url);

    let anonymous_args = youtube_args(&app, base_args.clone())?;
    let anonymous_error = match run_stream_resolve(&app, anonymous_args).await {
        Ok(stream) => return Ok(proxied_stream_url(&app, stream)),
        Err(error) => error,
    };
    if !has_configured_file(&app) {
        return Err(sanitize_ytdlp_error(
            &app,
            &anonymous_error,
            "The audio stream could not be resolved.",
        ));
    }

    let (args, cookie_snapshot) = authenticated_args(&app, base_args)?;
    let result = run_stream_resolve(&app, args).await;
    absorb_cookie_rotations(&app, &cookie_snapshot);
    match result {
        Ok(stream) => Ok(proxied_stream_url(&app, stream)),
        Err(error) => Err(sanitize_ytdlp_error(
            &app,
            &error,
            "The audio stream could not be resolved.",
        )),
    }
}

/// Download a track's audio into the library folder, emitting progress events.
#[tauri::command]
pub async fn download_song(
    app: AppHandle,
    url: String,
    video_id: String,
    library_dir: String,
    format: String,
) -> Result<DownloadResult, String> {
    std::fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;
    let dir = library_dir.trim_end_matches(['/', '\\']).to_string();
    let out_template = format!("{dir}/%(id)s.%(ext)s");

    // Audio-only source selection. Match the source codec to the target format
    // so yt-dlp copy-remuxes (no re-encode) where possible, and never fall back
    // to a muxed video stream the way the no-`-f` default can. bestaudio* picks
    // the best audio-only stream; the trailing /bestaudio guarantees a match on
    // odd sources.
    let fmt_selector = match format.as_str() {
        "opus" => "bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio*/bestaudio",
        "m4a" => "bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio*/bestaudio",
        _ => "bestaudio*/bestaudio", // mp3 (transcode unavoidable) and any other
    };

    let mut args: Vec<String> = vec![
        "-f".into(),
        fmt_selector.into(),
        "-x".into(),
        "--audio-format".into(),
        format.clone(),
        "--audio-quality".into(),
        "0".into(),
        "--embed-thumbnail".into(),
        "--embed-metadata".into(),
        "--no-playlist".into(),
        "--newline".into(),
        // --print implies --quiet, which silences the [download] percent lines
        // the progress parser needs; --progress re-enables them.
        "--progress".into(),
        "-o".into(),
        out_template,
        "--print".into(),
        "after_move:filepath".into(),
        // YouTube's own music credits (the "Music in this video" section /
        // auto-generated Topic metadata). yt-dlp prints the NA placeholder when
        // a video has none; credit_value() maps that back to None.
        "--print".into(),
        format!("after_move:{CREDITS_TRACK_PREFIX}%(track)s"),
        "--print".into(),
        format!("after_move:{CREDITS_ARTIST_PREFIX}%(artist)s"),
    ];
    if let Some(loc) = ffmpeg_location(&app) {
        args.push("--ffmpeg-location".into());
        args.push(loc.to_string_lossy().to_string());
    }
    // Bound stalled reads (a dead connection aborts and retries instead of
    // hanging the download forever), but keep yt-dlp's default retry counts —
    // robustness matters more than fail-fast on the download path.
    args.push("--socket-timeout".into());
    args.push("20".into());
    args.push(url);

    let (args, cookie_snapshot) = authenticated_args(&app, args)?;
    let (mut rx, _child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut file_path = String::new();
    let mut track: Option<String> = None;
    let mut artist: Option<String> = None;
    let mut stderr_buf = String::new();
    let mut exit_err: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                for line in chunk.lines() {
                    let line = line.trim();
                    if line.starts_with("[download]") {
                        if let Some(p) = parse_percent(line) {
                            let _ = app.emit(
                                "download-progress",
                                DownloadProgress {
                                    video_id: video_id.clone(),
                                    percent: p,
                                    status: "downloading".into(),
                                },
                            );
                        }
                    } else if let Some(v) = line.strip_prefix(CREDITS_TRACK_PREFIX) {
                        track = credit_value(v);
                    } else if let Some(v) = line.strip_prefix(CREDITS_ARTIST_PREFIX) {
                        artist = credit_value(v);
                    } else if !line.is_empty() && !line.starts_with('[') && looks_like_path(line) {
                        file_path = line.to_string();
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                for line in chunk.lines() {
                    if line.trim_start().starts_with("[download]") {
                        if let Some(p) = parse_percent(line) {
                            let _ = app.emit(
                                "download-progress",
                                DownloadProgress {
                                    video_id: video_id.clone(),
                                    percent: p,
                                    status: "downloading".into(),
                                },
                            );
                        }
                    }
                }
                stderr_buf.push_str(&chunk);
            }
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) {
                    exit_err = Some(if stderr_buf.trim().is_empty() {
                        format!("yt-dlp exited with code {:?}", payload.code)
                    } else {
                        stderr_buf.trim().to_string()
                    });
                }
            }
            _ => {}
        }
    }
    // The event stream closed, so yt-dlp has exited and rewritten the cookie
    // snapshot with any values YouTube rotated during the download.
    absorb_cookie_rotations(&app, &cookie_snapshot);

    if let Some(err) = exit_err {
        return Err(sanitize_ytdlp_error(
            &app,
            &err,
            "The song could not be downloaded.",
        ));
    }

    if file_path.is_empty() {
        let guess = PathBuf::from(&dir).join(format!("{video_id}.{format}"));
        if guess.exists() {
            file_path = guess.to_string_lossy().to_string();
        }
    }
    if file_path.is_empty() {
        return Err("Download finished but the output file was not found".into());
    }

    let _ = app.emit(
        "download-progress",
        DownloadProgress {
            video_id: video_id.clone(),
            percent: 100.0,
            status: "done".into(),
        },
    );

    Ok(DownloadResult {
        video_id,
        file_path,
        track,
        artist,
    })
}

const CREDITS_TRACK_PREFIX: &str = "CREDITS-TRACK::";
const CREDITS_ARTIST_PREFIX: &str = "CREDITS-ARTIST::";

/// yt-dlp prints "NA" for fields a video doesn't have; map that (and empty
/// strings) back to None so callers can fall back cleanly.
fn credit_value(raw: &str) -> Option<String> {
    let v = raw.trim();
    if v.is_empty() || v == "NA" {
        None
    } else {
        Some(v.to_string())
    }
}

fn looks_like_path(line: &str) -> bool {
    line.contains(":\\") || line.starts_with('/')
}

fn parse_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let token = line[..idx].split_whitespace().last()?;
    token.parse::<f64>().ok()
}

#[cfg(test)]
mod verification_tests {
    use super::*;

    #[test]
    fn only_expected_watch_later_json_verifies() {
        let ok = r#"{"_type":"playlist","id":"WL","extractor_key":"YoutubeTab"}"#;
        assert!(matches!(
            classify_verification_probe(true, ok, ""),
            VerificationProbe::Verified
        ));
        assert!(matches!(
            classify_verification_probe(
                true,
                r#"{"_type":"playlist","id":"history","extractor_key":"YoutubeTab"}"#,
                ""
            ),
            VerificationProbe::Transient(_)
        ));
    }

    #[test]
    fn every_youtube_command_gets_the_bundled_runtime_prefix() {
        let deno = Path::new(r"C:\Program Files\Local Music Player\deno.exe");
        let args = youtube_args_with_deno(deno, None, vec!["--version".into()]);
        assert_eq!(
            args,
            vec![
                "--ignore-config",
                "--js-runtimes",
                r"deno:C:\Program Files\Local Music Player\deno.exe",
                "--version",
            ]
        );
    }

    #[test]
    fn pot_flags_are_added_before_the_command_args_once_the_server_is_ready() {
        let deno = Path::new(r"C:\app\deno.exe");
        let pot = crate::bgutil::PotArgs {
            plugin_dir: PathBuf::from(r"C:\app\bgutil\plugin"),
            base_url: "http://127.0.0.1:41416".into(),
        };
        let args = youtube_args_with_deno(deno, Some(&pot), vec!["-g".into(), "URL".into()]);
        assert_eq!(
            args,
            vec![
                "--ignore-config",
                "--js-runtimes",
                r"deno:C:\app\deno.exe",
                "--plugin-dirs",
                r"C:\app\bgutil\plugin",
                "--extractor-args",
                "youtubepot-bgutilhttp:base_url=http://127.0.0.1:41416",
                "-g",
                "URL",
            ]
        );
    }

    #[test]
    fn login_required_is_rejected_but_network_errors_are_transient() {
        assert!(matches!(
            classify_verification_probe(
                false,
                "",
                "Login details are needed to download this content"
            ),
            VerificationProbe::Rejected
        ));
        assert!(matches!(
            classify_verification_probe(false, "", "Unable to connect: timed out"),
            VerificationProbe::Transient(_)
        ));
    }
}

/// Attempt to self-update the bundled yt-dlp binary.
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .arg("-U")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let mut msg = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !err.is_empty() {
        if !msg.is_empty() {
            msg.push('\n');
        }
        msg.push_str(&err);
    }
    // A failed update (e.g. the binary dir isn't writable in an installed
    // build) must surface as an error, not read like a success message.
    if !output.status.success() {
        return Err(if msg.is_empty() {
            format!("yt-dlp -U exited with code {:?}", output.status.code())
        } else {
            msg
        });
    }
    Ok(msg)
}
