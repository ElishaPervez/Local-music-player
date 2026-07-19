use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;
const COOKIE_HEADER: &str = "# Netscape HTTP Cookie File\n# Managed by Local Music Player. Do not edit while the app is running.\n";
const GENERATION_PREFIX: &str = "# LMP-Generation: ";
const COOKIE_FILE: &str = "youtube.cookies.txt";
const VERIFICATION_FILE: &str = "youtube.verification.json";
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
/// Serializes mutations of the managed cookie file (imports, removals, and
/// post-run rotation write-backs) so two concurrent yt-dlp runs can't
/// interleave a read-merge-write and drop each other's updates.
static MANAGED_FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeCookieStatus {
    pub state: CookieState,
    pub updated_at: Option<u64>,
    pub checked_at: Option<u64>,
    pub usable_cookie_count: usize,
    pub expired_cookie_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CookieState {
    NotConfigured,
    Unverified,
    Verified,
    Rejected,
    Expired,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum VerificationOutcome {
    Unverified,
    Verified,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerificationRecord {
    generation: String,
    outcome: VerificationOutcome,
    checked_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonCookie {
    domain: String,
    name: String,
    value: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    secure: bool,
    #[serde(default)]
    http_only: bool,
    #[serde(default)]
    host_only: Option<bool>,
    #[serde(default)]
    session: bool,
    #[serde(default)]
    expiration_date: Option<f64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CookieRecord {
    domain: String,
    include_subdomains: bool,
    path: String,
    secure: bool,
    expires: u64,
    name: String,
    value: String,
    http_only: bool,
}

impl CookieRecord {
    fn usable(&self, now: u64) -> bool {
        self.expires == 0 || self.expires > now
    }

    fn netscape_line(&self) -> String {
        let domain = if self.http_only {
            format!("#HttpOnly_{}", self.domain)
        } else {
            self.domain.clone()
        };
        format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            domain,
            if self.include_subdomains {
                "TRUE"
            } else {
                "FALSE"
            },
            self.path,
            if self.secure { "TRUE" } else { "FALSE" },
            self.expires,
            self.name,
            self.value
        )
    }
}

pub struct CookieSnapshot {
    path: PathBuf,
    generation: String,
}

impl CookieSnapshot {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }
}

impl Drop for CookieSnapshot {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn auth_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("auth"))
}

pub fn managed_cookie_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(auth_dir(app)?.join(COOKIE_FILE))
}

fn verification_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(auth_dir(app)?.join(VERIFICATION_FILE))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn updated_at_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(
        modified
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis()
            .min(u64::MAX as u128) as u64,
    )
}

fn unique_temp_path(dir: &Path, prefix: &str) -> PathBuf {
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        ".{prefix}-{}-{}-{id}.tmp",
        std::process::id(),
        unix_now()
    ))
}

fn create_private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|e| e.to_string())
}

fn write_records(
    path: &Path,
    records: &[CookieRecord],
    generation: Option<&str>,
) -> Result<(), String> {
    let mut file = create_private_file(path)?;
    file.write_all(COOKIE_HEADER.as_bytes())
        .map_err(|e| e.to_string())?;
    if let Some(generation) = generation {
        file.write_all(format!("{GENERATION_PREFIX}{generation}\n").as_bytes())
            .map_err(|e| e.to_string())?;
    }
    for record in records {
        file.write_all(record.netscape_line().as_bytes())
            .map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn replace_managed_file(temp: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temp, destination).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn replace_managed_file(temp: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let flags = if destination.exists() {
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
    } else {
        MOVEFILE_WRITE_THROUGH
    };
    let moved = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

fn cleanup_stale_temps(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(".cookie-import-") && !name.starts_with(".cookie-snapshot-") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
            .is_ok_and(|age| age.as_secs() >= 24 * 60 * 60);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn read_limited(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|_| "The selected cookie file could not be read.".to_string())?;
    if !metadata.is_file() {
        return Err("Select a Cookie-Editor JSON export or a Netscape cookies.txt file.".into());
    }
    if metadata.len() == 0 {
        return Err("The selected cookie file is empty.".into());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err("The selected cookie file is too large.".into());
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|_| "The selected cookie file could not be read.".to_string())?;
    let text = String::from_utf8(bytes)
        .map_err(|_| "The selected cookie file must be UTF-8 text.".to_string())?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

fn allowed_domain(domain: &str) -> bool {
    let domain = domain
        .strip_prefix("#HttpOnly_")
        .unwrap_or(domain)
        .trim_start_matches('.')
        .to_ascii_lowercase();
    [
        "youtube.com",
        "youtu.be",
        "youtube-nocookie.com",
        "googlevideo.com",
    ]
    .iter()
    .any(|base| domain == *base || domain.ends_with(&format!(".{base}")))
}

fn valid_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.');
    !domain.is_empty()
        && domain.len() <= 253
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn valid_cookie_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b > 0x20
                && b < 0x7f
                && !matches!(
                    b,
                    b'(' | b')'
                        | b'<'
                        | b'>'
                        | b'@'
                        | b','
                        | b';'
                        | b':'
                        | b'\\'
                        | b'"'
                        | b'/'
                        | b'['
                        | b']'
                        | b'?'
                        | b'='
                        | b'{'
                        | b'}'
                )
        })
}

fn safe_field(value: &str) -> bool {
    !value.contains(['\0', '\r', '\n', '\t'])
}

fn normalize_domain(domain: &str, include_subdomains: bool) -> String {
    let bare = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if include_subdomains {
        format!(".{bare}")
    } else {
        bare
    }
}

fn validate_record(record: &CookieRecord, location: &str) -> Result<(), String> {
    if !safe_field(&record.domain)
        || !safe_field(&record.path)
        || !safe_field(&record.name)
        || !safe_field(&record.value)
    {
        return Err(format!(
            "The cookie export contains invalid control characters at {location}."
        ));
    }
    if !valid_domain(&record.domain) {
        return Err(format!(
            "The cookie export contains an invalid domain at {location}."
        ));
    }
    if !record.path.starts_with('/') {
        return Err(format!(
            "The cookie export contains an invalid path at {location}."
        ));
    }
    if !valid_cookie_name(&record.name) {
        return Err(format!(
            "The cookie export contains an invalid cookie name at {location}."
        ));
    }
    Ok(())
}

fn parse_json(text: &str) -> Result<Vec<CookieRecord>, String> {
    let cookies: Vec<JsonCookie> = serde_json::from_str(text)
        .map_err(|_| "This JSON file is not a valid Cookie-Editor export.".to_string())?;
    let mut records = Vec::new();
    for (index, cookie) in cookies.into_iter().enumerate() {
        if !allowed_domain(&cookie.domain) {
            continue;
        }
        let include_subdomains = !cookie.host_only.unwrap_or(false);
        let expires = if cookie.session || cookie.expiration_date.is_none() {
            0
        } else {
            match cookie.expiration_date {
                Some(value) if value.is_finite() && value > 0.0 => value.floor() as u64,
                Some(value) if value.is_finite() => 1,
                _ => {
                    return Err(format!(
                        "The cookie export contains an invalid expiry at JSON item {}.",
                        index + 1
                    ))
                }
            }
        };
        let record = CookieRecord {
            domain: normalize_domain(&cookie.domain, include_subdomains),
            include_subdomains,
            path: cookie.path.unwrap_or_else(|| "/".into()),
            secure: cookie.secure,
            expires,
            name: cookie.name,
            value: cookie.value,
            http_only: cookie.http_only,
        };
        validate_record(&record, &format!("JSON item {}", index + 1))?;
        records.push(record);
    }
    Ok(records)
}

fn parse_bool(value: &str, line: usize) -> Result<bool, String> {
    match value {
        "TRUE" => Ok(true),
        "FALSE" => Ok(false),
        _ => Err(format!(
            "The Netscape cookie export has an invalid flag on line {line}."
        )),
    }
}

fn parse_netscape(text: &str) -> Result<Vec<CookieRecord>, String> {
    let mut records = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line_number = index + 1;
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() || (line.starts_with('#') && !line.starts_with("#HttpOnly_")) {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() != 7 {
            return Err(format!(
                "The Netscape cookie export has a malformed row on line {line_number}."
            ));
        }
        let http_only = fields[0].starts_with("#HttpOnly_");
        let raw_domain = fields[0].strip_prefix("#HttpOnly_").unwrap_or(fields[0]);
        if !allowed_domain(raw_domain) {
            continue;
        }
        let include_subdomains = parse_bool(fields[1], line_number)?;
        // yt-dlp writes session cookies with an EMPTY expiry field when it
        // saves a cookie jar; treat that like the explicit 0 we write ourselves.
        let expires = if fields[4].is_empty() {
            0
        } else {
            fields[4].parse::<u64>().map_err(|_| {
                format!("The Netscape cookie export has an invalid expiry on line {line_number}.")
            })?
        };
        let record = CookieRecord {
            domain: normalize_domain(raw_domain, include_subdomains),
            include_subdomains,
            path: fields[2].to_string(),
            secure: parse_bool(fields[3], line_number)?,
            expires,
            name: fields[5].to_string(),
            value: fields[6].to_string(),
            http_only,
        };
        validate_record(&record, &format!("line {line_number}"))?;
        records.push(record);
    }
    Ok(records)
}

fn parse_export(text: &str) -> Result<Vec<CookieRecord>, String> {
    let trimmed = text.trim_start();
    let records = if trimmed.starts_with('[') {
        parse_json(trimmed)?
    } else {
        parse_netscape(text)?
    };

    let mut deduped = BTreeMap::new();
    for record in records {
        deduped.insert(
            (
                record.domain.clone(),
                record.path.clone(),
                record.name.clone(),
            ),
            record,
        );
    }
    let records: Vec<_> = deduped.into_values().collect();
    if records.is_empty() {
        return Err(
            "No YouTube cookies were found. Export cookies while signed in at youtube.com and try again."
                .into(),
        );
    }
    if !records.iter().any(|record| record.usable(unix_now())) {
        return Err(
            "All YouTube cookies in this export are expired. Export a fresh file and try again."
                .into(),
        );
    }
    Ok(records)
}

fn read_managed_text(app: &AppHandle) -> Result<Option<String>, String> {
    let path = managed_cookie_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    read_limited(&path).map(Some)
}

fn read_managed_records(app: &AppHandle) -> Result<Option<Vec<CookieRecord>>, String> {
    let Some(text) = read_managed_text(app)? else {
        return Ok(None);
    };
    parse_netscape(&text).map(Some)
}

fn generation_from_text(text: &str, path: &Path) -> String {
    text.lines()
        .find_map(|line| line.strip_prefix(GENERATION_PREFIX))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("legacy-{}", updated_at_ms(path).unwrap_or(0)))
}

pub fn current_generation(app: &AppHandle) -> Result<Option<String>, String> {
    let path = managed_cookie_path(app)?;
    let Some(text) = read_managed_text(app)? else {
        return Ok(None);
    };
    Ok(Some(generation_from_text(&text, &path)))
}

fn read_verification(app: &AppHandle) -> Option<VerificationRecord> {
    let text = fs::read_to_string(verification_path(app).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_verification(app: &AppHandle, record: &VerificationRecord) -> Result<(), String> {
    let dir = auth_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let destination = verification_path(app)?;
    let temp = unique_temp_path(&dir, "verification");
    let mut file = create_private_file(&temp)?;
    let data = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    if let Err(error) = replace_managed_file(&temp, &destination) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

pub fn record_verification(
    app: &AppHandle,
    expected_generation: &str,
    outcome: VerificationOutcome,
) -> Result<YouTubeCookieStatus, String> {
    if current_generation(app)?.as_deref() != Some(expected_generation) {
        return Err(
            "The saved cookies changed while verification was running. Retry verification.".into(),
        );
    }
    write_verification(
        app,
        &VerificationRecord {
            generation: expected_generation.to_string(),
            checked_at: Some(unix_now() * 1000),
            outcome,
        },
    )?;
    cookie_status(app)
}

pub fn cookie_status(app: &AppHandle) -> Result<YouTubeCookieStatus, String> {
    let path = managed_cookie_path(app)?;
    if !path.exists() {
        return Ok(YouTubeCookieStatus {
            state: CookieState::NotConfigured,
            updated_at: None,
            checked_at: None,
            usable_cookie_count: 0,
            expired_cookie_count: 0,
        });
    }

    let records = match read_managed_records(app) {
        Ok(Some(records)) if !records.is_empty() => records,
        _ => {
            return Ok(YouTubeCookieStatus {
                state: CookieState::Invalid,
                updated_at: updated_at_ms(&path),
                checked_at: None,
                usable_cookie_count: 0,
                expired_cookie_count: 0,
            })
        }
    };
    let now = unix_now();
    let usable_cookie_count = records.iter().filter(|record| record.usable(now)).count();
    let expired_cookie_count = records.len() - usable_cookie_count;
    let generation = current_generation(app)?;
    let verification = read_verification(app)
        .filter(|record| generation.as_deref() == Some(record.generation.as_str()));
    let (state, checked_at) = if usable_cookie_count == 0 {
        (CookieState::Expired, None)
    } else {
        match verification {
            Some(record) if record.outcome == VerificationOutcome::Verified => {
                (CookieState::Verified, record.checked_at)
            }
            Some(record) if record.outcome == VerificationOutcome::Rejected => {
                (CookieState::Rejected, record.checked_at)
            }
            _ => (CookieState::Unverified, None),
        }
    };
    Ok(YouTubeCookieStatus {
        state,
        updated_at: updated_at_ms(&path),
        checked_at,
        usable_cookie_count,
        expired_cookie_count,
    })
}

#[tauri::command]
pub fn youtube_cookie_status(app: AppHandle) -> Result<YouTubeCookieStatus, String> {
    cookie_status(&app)
}

fn install_records(
    app: &AppHandle,
    records: &[CookieRecord],
) -> Result<YouTubeCookieStatus, String> {
    let _lock = MANAGED_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = auth_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    cleanup_stale_temps(&dir);
    let destination = managed_cookie_path(app)?;
    let generation = format!(
        "{}-{}-{}",
        unix_now(),
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    );
    let temp = unique_temp_path(&dir, "cookie-import");
    if let Err(error) = write_records(&temp, records, Some(&generation)) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    let _ = fs::remove_file(verification_path(app)?);
    if let Err(error) = replace_managed_file(&temp, &destination) {
        let _ = fs::remove_file(&temp);
        return Err(format!("The cookie file could not be installed: {error}"));
    }
    write_verification(
        app,
        &VerificationRecord {
            generation,
            outcome: VerificationOutcome::Unverified,
            checked_at: None,
        },
    )?;
    cookie_status(app)
}

#[tauri::command]
pub fn import_youtube_cookies(
    app: AppHandle,
    source_path: String,
) -> Result<YouTubeCookieStatus, String> {
    let text = read_limited(Path::new(&source_path))?;
    let records = parse_export(&text)?;
    install_records(&app, &records)
}

fn parse_pasted_export(cookie_text: &str) -> Result<Vec<CookieRecord>, String> {
    if cookie_text.trim().is_empty() {
        return Err("Paste Cookie-Editor JSON or Netscape cookie text first.".into());
    }
    if cookie_text.len() as u64 > MAX_IMPORT_BYTES {
        return Err("The pasted cookie text is too large.".into());
    }
    let text = cookie_text.strip_prefix('\u{feff}').unwrap_or(cookie_text);
    parse_export(text)
}

#[tauri::command]
pub fn import_youtube_cookies_text(
    app: AppHandle,
    cookie_text: String,
) -> Result<YouTubeCookieStatus, String> {
    let records = parse_pasted_export(&cookie_text)?;
    install_records(&app, &records)
}

#[tauri::command]
pub fn remove_youtube_cookies(app: AppHandle) -> Result<YouTubeCookieStatus, String> {
    let path = managed_cookie_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    if let Ok(path) = verification_path(&app) {
        let _ = fs::remove_file(path);
    }
    cookie_status(&app)
}

pub fn create_snapshot(app: &AppHandle) -> Result<Option<CookieSnapshot>, String> {
    let records = match read_managed_records(app) {
        Ok(Some(records)) => records,
        Ok(None) => return Ok(None),
        Err(_) => {
            return Err(
                "The saved YouTube cookie file is invalid. Update it from the cookie button, or remove it to use anonymous access."
                    .into(),
            )
        }
    };
    let now = unix_now();
    let usable: Vec<_> = records
        .into_iter()
        .filter(|record| record.usable(now))
        .collect();
    if usable.is_empty() {
        return Err(
            "The saved YouTube cookies are expired. Export a fresh file and use the cookie button to update them, or remove them to use anonymous access."
                .into(),
        );
    }
    let generation = current_generation(app)?.ok_or_else(|| {
        "The saved YouTube cookie generation could not be read. Update the cookies and retry."
            .to_string()
    })?;
    let dir = auth_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    cleanup_stale_temps(&dir);
    let path = unique_temp_path(&dir, "cookie-snapshot");
    write_records(&path, &usable, None)?;
    Ok(Some(CookieSnapshot { path, generation }))
}

pub fn has_configured_file(app: &AppHandle) -> bool {
    managed_cookie_path(app).is_ok_and(|path| path.exists())
}

fn record_key(record: &CookieRecord) -> (String, String, String) {
    (
        record.domain.clone(),
        record.path.clone(),
        record.name.clone(),
    )
}

/// Upsert the rotated records into the existing set. Returns None when nothing
/// actually changed (so callers can skip a pointless rewrite of the store).
fn merge_rotated(
    existing: Vec<CookieRecord>,
    rotated: Vec<CookieRecord>,
) -> Option<Vec<CookieRecord>> {
    let existing: BTreeMap<_, _> = existing
        .into_iter()
        .map(|record| (record_key(&record), record))
        .collect();
    let mut merged = existing.clone();
    for record in rotated {
        merged.insert(record_key(&record), record);
    }
    if merged == existing {
        None
    } else {
        Some(merged.into_values().collect())
    }
}

/// Fold cookie values YouTube rotated during a yt-dlp run back into the
/// managed store. yt-dlp rewrites the `--cookies` file it was given when it
/// exits; the snapshot is a throwaway copy, so without this merge every
/// rotation would be deleted with it and the stored cookies would fall one
/// rotation behind on every play until YouTube stops accepting them.
///
/// Best-effort by design: an unreadable or unparseable snapshot rewrite is a
/// no-op, never an error that breaks the command that just succeeded.
pub fn absorb_rotations(app: &AppHandle, snapshot: &CookieSnapshot) -> Result<bool, String> {
    let Ok(text) = read_limited(snapshot.path()) else {
        return Ok(false);
    };
    let Ok(rotated) = parse_netscape(&text) else {
        return Ok(false);
    };
    if rotated.is_empty() {
        return Ok(false);
    }
    let _lock = MANAGED_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // A newer import replaced the store while this run was in flight; its
    // cookies supersede anything this run rotated.
    if current_generation(app)?.as_deref() != Some(snapshot.generation()) {
        return Ok(false);
    }
    let Some(existing) = read_managed_records(app)? else {
        return Ok(false);
    };
    let Some(merged) = merge_rotated(existing, rotated) else {
        return Ok(false);
    };
    let dir = auth_dir(app)?;
    let destination = managed_cookie_path(app)?;
    let temp = unique_temp_path(&dir, "cookie-import");
    // Same generation on purpose: a rotation write-back is still the same
    // user-imported cookie set, so the verification verdict tied to it stays
    // valid and the auto-verify doesn't re-fire after every play.
    if let Err(error) = write_records(&temp, &merged, Some(snapshot.generation())) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = replace_managed_file(&temp, &destination) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_cookie_editor_json_and_filters_other_domains() {
        let text = r#"[
          {"domain":".youtube.com","hostOnly":false,"httpOnly":true,"name":"SID","path":"/","secure":true,"session":true,"value":"secret"},
          {"domain":"example.com","hostOnly":true,"name":"OTHER","path":"/","secure":false,"session":true,"value":"discard"}
        ]"#;
        let records = parse_export(text).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].domain, ".youtube.com");
        assert!(records[0].include_subdomains);
        assert!(records[0].http_only);
        assert_eq!(records[0].expires, 0);
        assert!(!records[0].netscape_line().contains("discard"));
    }

    #[test]
    fn parses_and_normalizes_netscape_http_only_rows() {
        let text =
            "# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret\n";
        let records = parse_export(text).unwrap();
        assert_eq!(records.len(), 1);
        assert!(records[0].http_only);
        assert_eq!(
            records[0].netscape_line(),
            "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret\n"
        );
    }

    #[test]
    fn rejects_expired_only_exports_without_echoing_values() {
        let text =
            "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\tvery-secret-value\n";
        let error = parse_export(text).unwrap_err();
        assert!(error.contains("expired"));
        assert!(!error.contains("very-secret-value"));

        let json = r#"[{"domain":"youtube.com","name":"SID","value":"secret","session":false,"expirationDate":-1}]"#;
        let error = parse_export(json).unwrap_err();
        assert!(error.contains("expired"));
        assert!(!error.contains("secret"));
    }

    #[test]
    fn pasted_text_accepts_bom_and_rejects_oversized_content() {
        let text = "\u{feff}[{\"domain\":\"youtube.com\",\"name\":\"SID\",\"value\":\"secret\",\"session\":true}]";
        let records = parse_pasted_export(text).unwrap();
        assert_eq!(records.len(), 1);

        let oversized = "secret".repeat(MAX_IMPORT_BYTES as usize / 6 + 1);
        let error = parse_pasted_export(&oversized).unwrap_err();
        assert!(error.contains("too large"));
        assert!(!error.contains("secretsecret"));
    }

    #[test]
    fn rejects_domain_suffix_tricks() {
        assert!(allowed_domain("music.youtube.com"));
        assert!(!allowed_domain("notyoutube.com"));
        assert!(!allowed_domain("youtube.com.example.org"));
    }

    #[test]
    fn ytdlp_style_empty_expiry_parses_as_session_cookie() {
        // yt-dlp saves session cookies with an empty expiry column.
        let text = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t\tSID\tsecret\n";
        let records = parse_netscape(text).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].expires, 0);
        assert!(records[0].usable(unix_now()));
    }

    #[test]
    fn merge_rotated_upserts_and_detects_no_change() {
        let base = |name: &str, value: &str| CookieRecord {
            domain: ".youtube.com".into(),
            include_subdomains: true,
            path: "/".into(),
            secure: true,
            expires: 0,
            name: name.into(),
            value: value.into(),
            http_only: false,
        };
        let existing = vec![base("SID", "old"), base("HSID", "keep")];

        // Rotated value replaces the old one; untouched cookies survive.
        let merged = merge_rotated(existing.clone(), vec![base("SID", "new")]).unwrap();
        assert_eq!(merged.len(), 2);
        assert!(merged
            .iter()
            .any(|r| r.name == "SID" && r.value == "new"));
        assert!(merged
            .iter()
            .any(|r| r.name == "HSID" && r.value == "keep"));

        // A brand-new cookie is added.
        let merged = merge_rotated(existing.clone(), vec![base("NEW", "v")]).unwrap();
        assert_eq!(merged.len(), 3);

        // Identical values → None, so callers skip the rewrite.
        assert!(merge_rotated(existing.clone(), vec![base("SID", "old")]).is_none());
    }

    #[test]
    fn last_duplicate_wins() {
        let text = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\told\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tnew\n";
        let records = parse_export(text).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].value, "new");
    }
}
