use crate::setup::ffmpeg_location;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    video_id: String,
    percent: f64,
    status: String,
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
    args.push(target);

    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

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

    if results.is_empty() && !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "No results".into()
        } else {
            err
        });
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

/// Resolve a direct audio stream URL for "play directly" (ephemeral, no download).
#[tauri::command]
pub async fn resolve_stream(app: AppHandle, url: String) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args([
            "-f",
            "bestaudio[ext=m4a]/bestaudio",
            "-g",
            "--no-playlist",
            "--no-warnings",
            &url,
        ])
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
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
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

    let mut args: Vec<String> = vec![
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
        "--no-warnings".into(),
        "-o".into(),
        out_template,
        "--print".into(),
        "after_move:filepath".into(),
    ];
    if let Some(loc) = ffmpeg_location(&app) {
        args.push("--ffmpeg-location".into());
        args.push(loc.to_string_lossy().to_string());
    }
    args.push(url);

    let (mut rx, _child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut file_path = String::new();
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

    if let Some(err) = exit_err {
        return Err(err);
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
    })
}

fn looks_like_path(line: &str) -> bool {
    line.contains(":\\") || line.starts_with('/')
}

fn parse_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let token = line[..idx].split_whitespace().last()?;
    token.parse::<f64>().ok()
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
