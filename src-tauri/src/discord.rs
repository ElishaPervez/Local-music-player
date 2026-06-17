//! Discord Rich Presence ("Discord activity") integration.
//!
//! The webview can't open Discord's local IPC pipe, so the connection lives
//! here in Rust. The frontend pushes the current playback state via the
//! `discord_set_presence` command; we keep a single IPC client alive and
//! reconnect lazily whenever Discord is (re)started.
//!
//! ──────────────────────────────────────────────────────────────────────────
//! ONE-TIME SETUP (only you can do this — it ties to your Discord account):
//!
//!   1. Go to https://discord.com/developers/applications → New Application.
//!      Name it "Local Music Player" (this is the name shown after
//!      "Listening to …" in Discord).
//!   2. Copy its *Application ID* and paste it into `DISCORD_APP_ID` below.
//!   3. (Optional, for the app icon) Rich Presence → Art Assets → upload a
//!      square image named exactly `app_icon`. You can also upload optional
//!      status badges named `play`, `pause`, `repeat`, `repeat_one`, `shuffle`
//!      — if they're missing Discord just omits the small icon, no error.
//!   4. Rebuild the app. Until a real ID is set, all presence calls no-op.
//! ──────────────────────────────────────────────────────────────────────────

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Deserialize;
use tauri::State;

/// Your Discord application ("Client") ID. See the setup notes above.
const DISCORD_APP_ID: &str = "1516900867373011084";

/// Reconnect attempts to Discord are throttled to at most one per this window,
/// so a closed Discord doesn't get hammered on every presence update.
const RECONNECT_THROTTLE: Duration = Duration::from_secs(15);

/// True once a real, numeric application id has been pasted in above.
fn is_configured() -> bool {
    DISCORD_APP_ID.len() >= 17 && DISCORD_APP_ID.bytes().all(|b| b.is_ascii_digit())
}

/// Playback snapshot pushed from the frontend on each meaningful change.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    title: String,
    artist: String,
    duration_sec: f64,
    position_sec: f64,
    is_playing: bool,
    /// "off" | "all" | "one"
    repeat: String,
    shuffle: bool,
    playlist_name: Option<String>,
}

/// The live IPC client plus the last time we tried to (re)connect.
#[derive(Default)]
struct DiscordConn {
    client: Option<DiscordIpcClient>,
    last_attempt: Option<Instant>,
}

impl DiscordConn {
    /// Ensure there's a live connection, connecting (at most once per throttle
    /// window) if Discord has since come online.
    fn ensure_connected(&mut self) -> Result<(), String> {
        if self.client.is_some() {
            return Ok(());
        }
        if let Some(t) = self.last_attempt {
            if t.elapsed() < RECONNECT_THROTTLE {
                return Err("Discord not connected".into());
            }
        }
        self.last_attempt = Some(Instant::now());
        let mut client = DiscordIpcClient::new(DISCORD_APP_ID);
        client.connect().map_err(|e| e.to_string())?;
        self.client = Some(client);
        Ok(())
    }
}

/// Tauri-managed wrapper so the connection survives across command calls.
#[derive(Default)]
pub struct DiscordState(Mutex<DiscordConn>);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Discord requires visible text fields to be 2..=128 characters.
fn clamp_field(s: &str) -> String {
    let mut t: String = s.chars().take(128).collect();
    while t.chars().count() < 2 {
        t.push(' ');
    }
    t
}

/// The second line: artist plus a compact loop/shuffle tag when relevant, so a
/// looping playlist is visible even without the optional small-icon badges.
fn build_state(p: &Presence) -> String {
    let mut parts: Vec<String> = Vec::new();
    let artist = p.artist.trim();
    if !artist.is_empty() {
        parts.push(format!("by {artist}"));
    }
    match p.repeat.as_str() {
        "one" => parts.push("🔂 Repeat one".into()),
        "all" => parts.push("🔁 Looping".into()),
        _ => {}
    }
    if p.shuffle {
        parts.push("🔀 Shuffle".into());
    }
    if parts.is_empty() {
        String::new()
    } else {
        clamp_field(&parts.join(" · "))
    }
}

/// The optional corner badge (small image key + hover text) reflecting state.
/// The image keys are optional art-asset uploads; if absent Discord just shows
/// no small icon.
fn status_badge(p: &Presence) -> (&'static str, String) {
    if !p.is_playing {
        return ("pause", "Paused".into());
    }
    match p.repeat.as_str() {
        "one" => ("repeat_one", "Repeating this track".into()),
        "all" => {
            let text = match p.playlist_name.as_deref().map(str::trim) {
                Some(n) if !n.is_empty() => format!("Looping {n}"),
                _ => "Looping playlist".into(),
            };
            ("repeat", text)
        }
        _ if p.shuffle => ("shuffle", "Shuffling".into()),
        _ => ("play", "Playing".into()),
    }
}

/// Translate a playback snapshot into a Discord activity payload.
fn build_activity(p: &Presence) -> Activity<'static> {
    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .details(clamp_field(&p.title));

    let state = build_state(p);
    if !state.is_empty() {
        activity = activity.state(state);
    }

    // Live progress bar (elapsed / remaining), only while actually playing.
    if p.is_playing && p.duration_sec.is_finite() && p.duration_sec > 0.0 {
        let pos = p.position_sec.clamp(0.0, p.duration_sec);
        let start = now_ms() - (pos * 1000.0) as i64;
        let end = start + (p.duration_sec * 1000.0) as i64;
        activity = activity.timestamps(Timestamps::new().start(start).end(end));
    }

    let large_text = match p.playlist_name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => clamp_field(&format!("Playlist: {n}")),
        _ => "Local Music Player".into(),
    };
    let (small_image, small_text) = status_badge(p);
    let assets = Assets::new()
        .large_image("app_icon")
        .large_text(large_text)
        .small_image(small_image)
        .small_text(clamp_field(&small_text));

    activity.assets(assets)
}

/// Push the current playback state to Discord (no-op until configured).
#[tauri::command]
pub fn discord_set_presence(state: State<DiscordState>, presence: Presence) -> Result<(), String> {
    if !is_configured() {
        return Ok(());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.ensure_connected()?;
    let activity = build_activity(&presence);
    if let Some(client) = conn.client.as_mut() {
        if let Err(e) = client.set_activity(activity) {
            // Most likely Discord was closed mid-session; drop the dead client
            // so the next update reconnects.
            conn.client = None;
            return Err(e.to_string());
        }
    }
    Ok(())
}

/// Remove the activity from Discord but keep the connection (e.g. nothing
/// playing, or the feature was toggled off).
#[tauri::command]
pub fn discord_clear(state: State<DiscordState>) -> Result<(), String> {
    if !is_configured() {
        return Ok(());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(client) = conn.client.as_mut() {
        let _ = client.clear_activity();
    }
    Ok(())
}

/// Clear the activity and fully close the IPC connection.
#[tauri::command]
pub fn discord_disconnect(state: State<DiscordState>) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut client) = conn.client.take() {
        let _ = client.clear_activity();
        let _ = client.close();
    }
    conn.last_attempt = None;
    Ok(())
}
