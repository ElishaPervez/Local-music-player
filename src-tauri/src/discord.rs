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

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::thread;
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

/// How often the worker wakes up to retry a snapshot that couldn't be
/// delivered (Discord wasn't running when it arrived). Without this retry,
/// starting Discord mid-song would show nothing until the next track change.
/// Actual reconnect I/O is still bounded by RECONNECT_THROTTLE; this tick is
/// cheap when there's nothing to retry.
const RETRY_INTERVAL: Duration = Duration::from_secs(5);

/// True once a real, numeric application id has been pasted in above.
fn is_configured() -> bool {
    DISCORD_APP_ID.len() >= 17 && DISCORD_APP_ID.bytes().all(|b| b.is_ascii_digit())
}

/// Playback snapshot pushed from the frontend on each meaningful change.
#[derive(Deserialize, Clone)]
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

/// The live IPC client plus the last time we tried to (re)connect. Owned solely
/// by the background worker thread, so no lock is needed to touch it.
#[derive(Default)]
struct DiscordConn {
    client: Option<DiscordIpcClient>,
    last_attempt: Option<Instant>,
}

impl DiscordConn {
    /// Ensure there's a live connection, connecting (at most once per throttle
    /// window) if Discord has since come online.
    ///
    /// NOTE: `connect()` does a blocking, timeout-less handshake read on
    /// Discord's IPC pipe (the crate exposes no timeout). That blocking now
    /// happens ONLY on the dedicated worker thread below — never on a command
    /// thread — so a slow or unresponsive Discord can at worst stall presence
    /// updates, never the UI or any other Tauri command.
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

    /// Push a playback snapshot to Discord, reconnecting if needed.
    fn apply(&mut self, p: &Presence) -> Result<(), String> {
        if !is_configured() {
            return Ok(());
        }
        self.ensure_connected()?;
        let activity = build_activity(p);
        if let Some(client) = self.client.as_mut() {
            if let Err(e) = client.set_activity(activity) {
                // Most likely Discord was closed mid-session; drop the dead
                // client so the next update reconnects.
                self.client = None;
                return Err(e.to_string());
            }
        }
        Ok(())
    }

    /// Remove the activity but keep the connection alive.
    fn clear(&mut self) {
        if !is_configured() {
            return;
        }
        if let Some(client) = self.client.as_mut() {
            let _ = client.clear_activity();
        }
    }

    /// Clear the activity and fully close the IPC connection.
    fn disconnect(&mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = client.clear_activity();
            let _ = client.close();
        }
        self.last_attempt = None;
    }
}

/// A request handed to the Discord worker thread.
enum Msg {
    Set(Presence),
    Clear,
    Disconnect,
}

/// Run the IPC client on its own thread. All blocking pipe I/O lives here so it
/// can never stall a Tauri command thread. Requests that pile up while a slow
/// `connect()`/`set_activity()` is in flight are coalesced latest-wins, so a
/// playlist firing one push per track can't build an unbounded backlog.
fn worker(rx: Receiver<Msg>) {
    let mut conn = DiscordConn::default();
    // The latest snapshot that has NOT reached Discord (it wasn't running, or
    // the pipe broke mid-write), plus when it was captured. Retried on a timer
    // so launching Discord mid-song picks the song up within seconds instead
    // of waiting for the next track/pause change in the app.
    let mut undelivered: Option<(Presence, Instant)> = None;
    loop {
        let mut msg = match rx.recv_timeout(RETRY_INTERVAL) {
            Ok(m) => Some(m),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        // Drain everything already queued and keep only the most recent request
        // — each presence push is a full snapshot, so older ones are obsolete.
        loop {
            match rx.try_recv() {
                Ok(m) => msg = Some(m),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        // Isolate each request: errors are swallowed (presence is best-effort)
        // and an unexpected panic inside the IPC crate must not kill the worker
        // for the rest of the session — we drop the (possibly half-broken)
        // client so the next request reconnects cleanly.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match msg {
            Some(Msg::Set(p)) => {
                let received = Instant::now();
                match conn.apply(&p) {
                    Ok(()) => undelivered = None,
                    Err(_) => undelivered = Some((p, received)),
                }
            }
            Some(Msg::Clear) => {
                undelivered = None;
                conn.clear();
            }
            Some(Msg::Disconnect) => {
                undelivered = None;
                conn.disconnect();
            }
            // Retry tick. The snapshot's position is stale by however long it
            // sat here, so advance it for a playing track — otherwise the
            // progress bar would start where the song was when Discord was
            // still closed.
            None => {
                if let Some((p, since)) = undelivered.take() {
                    let mut adjusted = p.clone();
                    if adjusted.is_playing && adjusted.duration_sec > 0.0 {
                        adjusted.position_sec = (adjusted.position_sec
                            + since.elapsed().as_secs_f64())
                        .min(adjusted.duration_sec);
                    }
                    if conn.apply(&adjusted).is_err() {
                        undelivered = Some((p, since));
                    }
                }
            }
        }));
        if outcome.is_err() {
            conn.client = None;
            conn.last_attempt = None;
        }
    }
}

/// Tauri-managed handle to the worker thread. Commands only enqueue a request
/// and return immediately, so they never block.
pub struct DiscordState(Sender<Msg>);

impl Default for DiscordState {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel::<Msg>();
        thread::spawn(move || worker(rx));
        DiscordState(tx)
    }
}

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

/// "m:ss" (or "h:mm:ss") for the paused-at readout.
fn fmt_clock(sec: f64) -> String {
    let total = sec.max(0.0) as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// The second line: artist plus a compact loop/shuffle tag when relevant, so a
/// looping playlist is visible even without the optional small-icon badges.
/// Paused playback shows the frozen position (Discord's native bar only exists
/// while timestamps are set, i.e. while playing). Progress itself is left to
/// Discord's native bar — its look (colour, playhead) is drawn by the Discord
/// client and can't be customised by any app.
fn build_state(p: &Presence) -> String {
    let mut parts: Vec<String> = Vec::new();
    let artist = p.artist.trim();
    if !artist.is_empty() {
        parts.push(format!("by {artist}"));
    }
    if !p.is_playing {
        if p.duration_sec.is_finite() && p.duration_sec > 0.0 {
            let pos = p.position_sec.clamp(0.0, p.duration_sec);
            parts.push(format!("⏸ {} / {}", fmt_clock(pos), fmt_clock(p.duration_sec)));
        } else {
            parts.push("⏸ Paused".into());
        }
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
///
/// Only enqueues the request; the actual (blocking) IPC happens on the worker
/// thread, so this returns immediately and never blocks the caller.
#[tauri::command]
pub fn discord_set_presence(state: State<DiscordState>, presence: Presence) -> Result<(), String> {
    let _ = state.0.send(Msg::Set(presence));
    Ok(())
}

/// Remove the activity from Discord but keep the connection (e.g. nothing
/// playing, or the feature was toggled off).
#[tauri::command]
pub fn discord_clear(state: State<DiscordState>) -> Result<(), String> {
    let _ = state.0.send(Msg::Clear);
    Ok(())
}

/// Clear the activity and fully close the IPC connection.
#[tauri::command]
pub fn discord_disconnect(state: State<DiscordState>) -> Result<(), String> {
    let _ = state.0.send(Msg::Disconnect);
    Ok(())
}
