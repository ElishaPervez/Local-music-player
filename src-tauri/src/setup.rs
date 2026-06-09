use futures_util::StreamExt;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Pinned source for the first-run ffmpeg install. The "essentials" build is
/// the smallest official static build that still has every codec yt-dlp's
/// audio extraction needs.
const FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

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
#[tauri::command]
pub async fn install_ffmpeg(app: AppHandle) -> Result<String, String> {
    let tools = tools_dir(&app)?;
    std::fs::create_dir_all(&tools).map_err(|e| e.to_string())?;
    let zip_path = tools.join("ffmpeg-download.zip");

    emit_progress(&app, "downloading", 0.0);
    let resp = reqwest::get(FFMPEG_URL)
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    let mut file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut got: u64 = 0;
    let mut last_emit = 0.0_f64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download failed: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if total > 0 {
            let pct = (got as f64 / total as f64) * 100.0;
            if pct - last_emit >= 1.0 {
                last_emit = pct;
                emit_progress(&app, "downloading", pct);
            }
        }
    }
    drop(file);

    emit_progress(&app, "extracting", 0.0);
    let dest = tools.clone();
    let zip2 = zip_path.clone();
    let extracted =
        tauri::async_runtime::spawn_blocking(move || extract_ffmpeg(&zip2, &dest))
            .await
            .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&zip_path);
    extracted?;

    emit_progress(&app, "done", 100.0);
    Ok(tools.to_string_lossy().to_string())
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
