use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Serves resolved googlevideo audio to the webview from 127.0.0.1.
///
/// The audio element must never fetch googlevideo directly: the CDN can answer
/// a no-Range request with a one-time 302 typed text/html + nosniff, and the
/// webview's opaque-response blocker (ORB) then kills the media load outright
/// (net::ERR_BLOCKED_BY_ORB) — the element reports "Format error" and the
/// player skips the track. This proxy forwards the element's requests (Range
/// header included) with a real HTTP client that follows redirects server-side,
/// so the webview only ever sees a clean audio response it cannot object to.
pub struct StreamProxy {
    port: u16,
    token: String,
    next_handle: AtomicU64,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

struct Entry {
    upstream: String,
    /// Unix seconds after which the upstream URL is dead and the entry prunable.
    expires: u64,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Random hex from the std hasher's per-instance entropy — plenty for a
/// loopback-only bearer token guarding URLs that only lead to YouTube audio.
fn random_hex() -> String {
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(unix_now());
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

/// Pull the expiry stamp (unix seconds) out of a googlevideo URL — an
/// `expire=` query param or an `/expire/<ts>/` path segment.
fn extract_expire(url: &str) -> Option<u64> {
    if let Some((_, query)) = url.split_once('?') {
        for pair in query.split('&') {
            if let Some(value) = pair.strip_prefix("expire=") {
                if let Ok(n) = value.parse() {
                    return Some(n);
                }
            }
        }
    }
    if let Some(idx) = url.find("/expire/") {
        let digits: String = url[idx + "/expire/".len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(n) = digits.parse() {
            return Some(n);
        }
    }
    None
}

impl StreamProxy {
    /// Bind a loopback port and start serving. Called once at app startup.
    pub fn start() -> Result<Self, String> {
        let server = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| format!("stream proxy could not bind: {e}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or("stream proxy has no ip addr")?
            .port();
        let entries: Arc<Mutex<HashMap<String, Entry>>> = Arc::default();
        let token = random_hex();

        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // Bounds a stalled upstream read; a whole audio file is a few MB,
            // so a healthy transfer finishes far inside this. On a trip the
            // element errors and the player's retry path resolves fresh.
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;

        let thread_entries = Arc::clone(&entries);
        let thread_token = token.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let client = client.clone();
                let entries = Arc::clone(&thread_entries);
                let token = thread_token.clone();
                std::thread::spawn(move || handle_request(&client, &entries, &token, request));
            }
        });

        Ok(Self {
            port,
            token,
            next_handle: AtomicU64::new(0),
            entries,
        })
    }

    /// Map an upstream stream URL to a loopback URL for the audio element.
    /// The returned URL carries the upstream's `expire` stamp so the frontend
    /// freshness check keeps working unchanged.
    pub fn register(&self, upstream: &str) -> String {
        // Unstamped upstreams get a conservative lifetime (they realistically
        // last ~6h; the frontend re-resolves on playback error anyway).
        let expires = extract_expire(upstream).unwrap_or_else(|| unix_now() + 4 * 3600);
        let handle = format!(
            "{}-{}",
            self.next_handle.fetch_add(1, Ordering::Relaxed),
            random_hex()
        );
        let now = unix_now();
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        // Keep dead upstreams a grace period past expiry, then drop them so a
        // long session can't grow the map without bound.
        entries.retain(|_, entry| entry.expires + 600 > now);
        entries.insert(
            handle.clone(),
            Entry {
                upstream: upstream.to_string(),
                expires,
            },
        );
        format!(
            "http://127.0.0.1:{}/s/{}?t={}&expire={}",
            self.port, handle, self.token, expires
        )
    }
}

fn handle_request(
    client: &reqwest::blocking::Client,
    entries: &Mutex<HashMap<String, Entry>>,
    token: &str,
    request: tiny_http::Request,
) {
    let url = request.url();
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let authorized = query
        .split('&')
        .any(|pair| pair.strip_prefix("t=") == Some(token));
    if !authorized {
        let _ = request.respond(tiny_http::Response::empty(403));
        return;
    }
    let upstream = path.strip_prefix("/s/").and_then(|handle| {
        let entries = entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.get(handle).map(|entry| entry.upstream.clone())
    });
    let Some(upstream) = upstream else {
        let _ = request.respond(tiny_http::Response::empty(404));
        return;
    };

    // Forward the element's Range header verbatim — googlevideo answers Range
    // requests with a clean 206; byte offsets must match what the element asked.
    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());
    let mut upstream_request = client.get(&upstream);
    if let Some(range) = range {
        upstream_request = upstream_request.header("Range", range);
    }
    let response = match upstream_request.send() {
        Ok(response) => response,
        Err(_) => {
            let _ = request.respond(tiny_http::Response::empty(502));
            return;
        }
    };

    let status = response.status().as_u16();
    let mut headers = Vec::new();
    for name in ["Content-Type", "Content-Range", "Content-Length"] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
                headers.push(header);
            }
        }
    }
    if let Ok(header) = tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]) {
        headers.push(header);
    }
    let length = response.content_length().map(|l| l as usize);
    // Streams the upstream body straight through; respond() only fails if the
    // element aborted (seek, track change) — normal, nothing to clean up.
    let _ = request.respond(tiny_http::Response::new(
        tiny_http::StatusCode(status),
        headers,
        response,
        length,
        None,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_expiry_from_query_and_path_forms() {
        assert_eq!(
            extract_expire("https://rr1.googlevideo.com/videoplayback?expire=1784407877&id=x"),
            Some(1784407877)
        );
        assert_eq!(
            extract_expire("https://rr1.googlevideo.com/videoplayback/expire/1784407877/id/x"),
            Some(1784407877)
        );
        assert_eq!(extract_expire("https://example.com/audio.m4a"), None);
    }

    #[test]
    fn registered_urls_carry_token_and_expiry_and_prune_dead_entries() {
        let proxy = StreamProxy {
            port: 12345,
            token: "tok".into(),
            next_handle: AtomicU64::new(0),
            entries: Arc::default(),
        };
        let dead = unix_now() - 7200; // past expiry + grace
        proxy.register(&format!("https://cdn/videoplayback?expire={dead}"));
        assert_eq!(proxy.entries.lock().unwrap().len(), 1);

        let live = unix_now() + 3600;
        let url = proxy.register(&format!("https://cdn/videoplayback?expire={live}"));
        assert!(url.starts_with("http://127.0.0.1:12345/s/"));
        assert!(url.contains("t=tok"));
        assert!(url.contains(&format!("expire={live}")));
        // The dead entry was pruned during the second register.
        assert_eq!(proxy.entries.lock().unwrap().len(), 1);
    }
}
