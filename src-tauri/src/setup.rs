use futures_util::StreamExt;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Sources for the first-run ffmpeg install, tried in order. The "essentials"
/// build is the smallest official static build that still has every codec
/// yt-dlp's audio extraction needs. gyan.dev is a single-origin server that is
/// slow or unreachable from some networks, so two GitHub-CDN mirrors back it
/// up: GyanD/codexffmpeg republishes the identical essentials build, and BtbN
/// is an independent build (bigger, GPL) whose zip nests the exes under the
/// same `*/bin/` layout the extractor expects.
const FFMPEG_SOURCES: &[&str] = &[
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip",
];

const DOWNLOAD_ATTEMPTS_PER_SOURCE: u32 = 3;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    pub ffmpeg_installed: bool,
    pub ffmpeg_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SetupProgress {
    step: String,
    percent: f64,
}

/// Writable per-user dir where the first-run setup installs external tools.
/// Lives in app-data (not the install dir) so installs never need admin rights.
pub fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tools"))
}

/// Directory containing ffmpeg/ffprobe, for yt-dlp's --ffmpeg-location.
/// Checked in order: first-run install dir, bundled resources, dev checkout.
pub fn ffmpeg_location(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(tools) = tools_dir(app) {
        if tools.join("ffmpeg.exe").exists() && tools.join("ffprobe.exe").exists() {
            return Some(tools);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let nested = res.join("resources");
        if nested.join("ffmpeg.exe").exists() {
            return Some(nested);
        }
        if res.join("ffmpeg.exe").exists() {
            return Some(res);
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        if dev.join("ffmpeg.exe").exists() {
            return Some(dev);
        }
    }
    None
}

#[tauri::command]
pub fn tools_status(app: AppHandle) -> ToolsStatus {
    let loc = ffmpeg_location(&app);
    ToolsStatus {
        ffmpeg_installed: loc.is_some(),
        ffmpeg_path: loc.map(|p| p.to_string_lossy().to_string()),
    }
}

fn emit_progress(app: &AppHandle, step: &str, percent: f64) {
    let _ = app.emit(
        "setup-progress",
        SetupProgress {
            step: step.into(),
            percent,
        },
    );
}

/// Download the ffmpeg essentials build and install ffmpeg.exe + ffprobe.exe
/// into the per-user tools dir, emitting `setup-progress` events along the way.
/// Tries each source with per-source retries (resuming partial downloads), and
/// falls through to the next mirror if a source can't be downloaded or its
/// archive is unusable.
#[tauri::command]
pub async fn install_ffmpeg(app: AppHandle) -> Result<String, String> {
    let tools = tools_dir(&app)?;
    std::fs::create_dir_all(&tools).map_err(|e| e.to_string())?;
    let zip_path = tools.join("ffmpeg-download.zip");

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(30))
        .user_agent("local-music-player-setup")
        .build()
        .map_err(|e| e.to_string())?;

    let mut errors: Vec<String> = Vec::new();
    for url in FFMPEG_SOURCES {
        // Partial files never carry over between mirrors — different archives.
        let _ = std::fs::remove_file(&zip_path);
        emit_progress(&app, "downloading", 0.0);
        if let Err(e) = download_with_retries(&app, &client, url, &zip_path).await {
            errors.push(format!("{}: {e}", source_host(url)));
            continue;
        }

        emit_progress(&app, "extracting", 0.0);
        let dest = tools.clone();
        let zip2 = zip_path.clone();
        let extracted =
            tauri::async_runtime::spawn_blocking(move || extract_ffmpeg(&zip2, &dest))
                .await
                .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&zip_path);
        match extracted {
            Ok(()) => {
                emit_progress(&app, "done", 100.0);
                return Ok(tools.to_string_lossy().to_string());
            }
            Err(e) => errors.push(format!("{}: {e}", source_host(url))),
        }
    }

    let _ = std::fs::remove_file(&zip_path);
    Err(format!(
        "Couldn't download FFmpeg — check your internet connection (or firewall/antivirus) and try again. Details: {}",
        errors.join(" • ")
    ))
}

/// Short label for error messages, e.g. "www.gyan.dev" or "github.com".
fn source_host(url: &str) -> &str {
    url.split('/').nth(2).unwrap_or(url)
}

async fn download_with_retries(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    zip_path: &Path,
) -> Result<(), String> {
    let mut last_err = String::new();
    for attempt in 1..=DOWNLOAD_ATTEMPTS_PER_SOURCE {
        if attempt > 1 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        match download_once(app, client, url, zip_path).await {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// One download attempt. If a partial file exists from a previous attempt,
/// asks the server to resume from where it left off instead of starting over.
async fn download_once(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    zip_path: &Path,
) -> Result<(), String> {
    let have = std::fs::metadata(zip_path).map(|m| m.len()).unwrap_or(0);
    let mut req = client.get(url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let resp = req.send().await.map_err(describe_reqwest_err)?;
    let status = resp.status();

    let (mut file, mut got, total) = if status == reqwest::StatusCode::PARTIAL_CONTENT && have > 0 {
        let total = have + resp.content_length().unwrap_or(0);
        let file = std::fs::OpenOptions::new()
            .append(true)
            .open(zip_path)
            .map_err(|e| e.to_string())?;
        (file, have, total)
    } else if status.is_success() {
        // Fresh download, or the server ignored our Range header: start over.
        let total = resp.content_length().unwrap_or(0);
        let file = std::fs::File::create(zip_path).map_err(|e| e.to_string())?;
        (file, 0u64, total)
    } else {
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            // Stale/over-long partial file; clear it so the retry starts fresh.
            let _ = std::fs::remove_file(zip_path);
        }
        return Err(format!("HTTP {status}"));
    };

    let mut stream = resp.bytes_stream();
    let mut last_emit = -1.0_f64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(describe_reqwest_err)?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if total > 0 {
            let pct = (got as f64 / total as f64) * 100.0;
            if pct - last_emit >= 1.0 {
                last_emit = pct;
                emit_progress(app, "downloading", pct);
            }
        }
    }

    if total > 0 && got < total {
        return Err(format!("connection dropped at {got} of {total} bytes"));
    }
    Ok(())
}

/// reqwest's Display is vague ("error decoding response body"); append the
/// underlying cause chain so users see e.g. "connection reset by peer".
fn describe_reqwest_err(e: reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(cause) = src {
        let cause_str = cause.to_string();
        if !msg.contains(&cause_str) {
            msg.push_str(": ");
            msg.push_str(&cause_str);
        }
        src = cause.source();
    }
    msg
}

/// Pull just ffmpeg.exe and ffprobe.exe out of the release zip (which nests
/// them under a versioned folder, e.g. ffmpeg-7.1-essentials_build/bin/).
fn extract_ffmpeg(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut found = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let out_name = if name.ends_with("/bin/ffmpeg.exe") {
            "ffmpeg.exe"
        } else if name.ends_with("/bin/ffprobe.exe") {
            "ffprobe.exe"
        } else {
            continue;
        };
        let mut out = std::fs::File::create(dest.join(out_name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        found += 1;
    }
    if found < 2 {
        return Err("Archive did not contain ffmpeg.exe and ffprobe.exe".into());
    }
    Ok(())
}
