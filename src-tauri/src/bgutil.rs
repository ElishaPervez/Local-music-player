//! Hosts the bgutil-ytdlp-pot-provider so yt-dlp can attach proof-of-origin
//! (PO) tokens to YouTube requests. Without one, the CDN refuses to serve
//! stream URLs minted under a signed-in session (HTTP 403), so cookie-based
//! resolves "succeed" and then silently never play.
//!
//! Two bundled pieces (fetched by scripts/setup-tools.ps1, pinned version):
//!   resources/bgutil/plugin  — the yt-dlp plugin package, passed via
//!                              --plugin-dirs (read-only is fine)
//!   resources/bgutil/server  — the token generator's TypeScript source, run
//!                              as a persistent HTTP server by the bundled
//!                              Deno runtime
//!
//! The server source is copied to the app data dir first because Deno must
//! create a node_modules directory next to package.json (`deno install`),
//! which cannot happen under Program Files. Startup is fully asynchronous and
//! best-effort: until the server answers /ping — or if anything here fails —
//! yt-dlp simply runs without PO tokens, exactly as before this module
//! existed.
//!
//! The server process is placed in a Windows job object configured to kill
//! its members when the last handle closes: whatever way the app dies, the
//! Deno server dies with it instead of lingering as an orphan.

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
pub struct PotArgs {
    pub plugin_dir: PathBuf,
    pub base_url: String,
}

#[derive(Default)]
pub struct PotProvider {
    ready: OnceLock<PotArgs>,
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    job: Mutex<Option<job::Job>>,
}

impl PotProvider {
    /// The extra yt-dlp flags, once (and only once) the server is confirmed
    /// reachable. None means "run without PO tokens".
    pub fn args(&self) -> Option<PotArgs> {
        self.ready.get().cloned()
    }
}

/// Spawn the whole init sequence on a background thread; the app must never
/// wait on npm downloads or server compilation to show its window.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(error) = init(&app) {
            eprintln!("PO token provider unavailable: {error}");
        }
    });
}

fn init(app: &AppHandle) -> Result<(), String> {
    let resources = bgutil_resource_dir(app)
        .ok_or("bundled bgutil files are missing (run scripts/setup-tools.ps1)")?;
    let plugin_dir = resources.join("plugin");
    if !plugin_dir
        .join("bgutil-ytdlp-pot-provider/yt_dlp_plugins")
        .is_dir()
    {
        return Err("bundled bgutil plugin package is missing".into());
    }
    let version = fs::read_to_string(resources.join("VERSION"))
        .map_err(|e| format!("bgutil VERSION file unreadable: {e}"))?
        .trim()
        .to_string();
    let deno = crate::ytdlp::deno_path(app).ok_or("bundled Deno runtime is missing")?;

    let provider = app.state::<PotProvider>();
    #[cfg(windows)]
    {
        *provider.job.lock().unwrap_or_else(|e| e.into_inner()) = job::Job::new();
    }

    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bgutil");
    let server_dir = sync_and_install(app, &resources.join("server"), &data_root, &version, &deno)?;

    let port = free_port()?;
    let child = spawn_server(&deno, &server_dir, &data_root, port)?;
    #[cfg(windows)]
    if let Some(job) = provider.job.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        job.assign(&child);
    }
    *provider.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

    let base_url = format!("http://127.0.0.1:{port}");
    wait_ready(app, &base_url)?;
    let _ = provider.ready.set(PotArgs {
        plugin_dir,
        base_url,
    });
    Ok(())
}

fn bgutil_resource_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        for path in [resources.join("bgutil"), resources.join("resources/bgutil")] {
            if path.join("VERSION").is_file() {
                return Some(path);
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/bgutil");
        if path.join("VERSION").is_file() {
            return Some(path);
        }
    }
    None
}

/// Mirror the server source into the writable app data dir and install its
/// npm dependencies there. Skipped entirely (fast path) when the recorded
/// version already matches and node_modules exists.
fn sync_and_install(
    app: &AppHandle,
    source: &Path,
    data_root: &Path,
    version: &str,
    deno: &Path,
) -> Result<PathBuf, String> {
    let server_dir = data_root.join("server");
    let marker = data_root.join("installed-version.txt");
    let up_to_date = fs::read_to_string(&marker).is_ok_and(|v| v.trim() == version)
        && server_dir.join("node_modules").is_dir();
    if up_to_date {
        return Ok(server_dir);
    }

    for dir in ["src", "types"] {
        let dest = server_dir.join(dir);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        copy_dir(&source.join(dir), &dest)?;
    }
    for file in ["package.json", "deno.lock", "tsconfig.json"] {
        fs::copy(source.join(file), server_dir.join(file)).map_err(|e| e.to_string())?;
    }
    patch_loopback_bind(&server_dir.join("src/main.ts"))?;
    run_deno_install(app, deno, &server_dir, data_root)?;
    fs::write(&marker, version).map_err(|e| e.to_string())?;
    Ok(server_dir)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let dest = to.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Upstream binds the token server to every network interface. Rewrite our
/// copy to loopback only — nothing outside this machine should ever reach
/// it. If upstream changes the source and the patch no-ops, the later /ping
/// check against 127.0.0.1 fails and the provider stays off (safe).
fn patch_loopback_bind(main_ts: &Path) -> Result<(), String> {
    let text = fs::read_to_string(main_ts).map_err(|e| e.to_string())?;
    let patched = text
        .replace("host: \"::\"", "host: \"127.0.0.1\"")
        .replace("host: \"0.0.0.0\"", "host: \"127.0.0.1\"");
    fs::write(main_ts, patched).map_err(|e| e.to_string())
}

fn deno_command(deno: &Path, server_dir: &Path) -> Command {
    let mut command = Command::new(deno);
    command
        .current_dir(server_dir)
        .env("DENO_NO_PROMPT", "1")
        .env("DENO_NO_UPDATE_CHECK", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn run_deno_install(
    app: &AppHandle,
    deno: &Path,
    server_dir: &Path,
    data_root: &Path,
) -> Result<(), String> {
    let mut child = deno_command(deno, server_dir)
        .arg("install")
        .stdout(log_file(data_root, "install.log")?)
        .stderr(log_file(data_root, "install.log")?)
        .spawn()
        .map_err(|e| format!("deno install failed to start: {e}"))?;
    #[cfg(windows)]
    if let Some(job) = app
        .state::<PotProvider>()
        .job
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        job.assign(&child);
    }
    #[cfg(not(windows))]
    let _ = app;
    let status = child
        .wait()
        .map_err(|e| format!("deno install did not finish: {e}"))?;
    if !status.success() {
        return Err(format!(
            "deno install exited with {status} (see {})",
            data_root.join("install.log").display()
        ));
    }
    Ok(())
}

fn log_file(data_root: &Path, name: &str) -> Result<Stdio, String> {
    fs::create_dir_all(data_root).map_err(|e| e.to_string())?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_root.join(name))
        .map(Stdio::from)
        .map_err(|e| e.to_string())
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

fn spawn_server(
    deno: &Path,
    server_dir: &Path,
    data_root: &Path,
    port: u16,
) -> Result<Child, String> {
    // Fresh log per launch so it only ever describes the current server.
    let log_path = data_root.join("server.log");
    let _ = fs::remove_file(&log_path);
    deno_command(deno, server_dir)
        .args([
            "run",
            "--allow-env",
            "--allow-net",
            "--allow-ffi=node_modules",
            "--allow-read=.",
            "--allow-write=.",
            "src/main.ts",
            "--port",
        ])
        .arg(port.to_string())
        .stdout(log_file(data_root, "server.log")?)
        .stderr(log_file(data_root, "server.log")?)
        .spawn()
        .map_err(|e| format!("token server failed to start: {e}"))
}

/// Poll /ping until the server answers. Generous deadline: the very first
/// launch after an install also pays Deno's TypeScript compilation.
fn wait_ready(app: &AppHandle, base_url: &str) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(90);
    let url = format!("{base_url}/ping");
    loop {
        if let Ok(response) = client.get(&url).send() {
            if response.status().is_success() {
                return Ok(());
            }
        }
        // A dead child will never answer; fail fast with a pointer to its log.
        let provider = app.state::<PotProvider>();
        let mut child = provider.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = child.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("token server exited with {status} during startup"));
            }
        }
        drop(child);
        if Instant::now() >= deadline {
            return Err("token server did not answer /ping within 90s".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Kill-on-close job object: every process assigned to it is terminated
    /// by the OS when the last handle closes — i.e. when this app exits for
    /// any reason, including a crash.
    pub struct Job(HANDLE);

    // The raw handle is only ever used through &self and the OS object is
    // thread-safe.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Job(handle))
            }
        }

        pub fn assign(&self, child: &std::process::Child) {
            unsafe {
                AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
