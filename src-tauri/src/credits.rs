//! Music credits lookup via YouTube Music's internal `next` endpoint.
//!
//! Given a videoId, YouTube Music's watch queue returns the *catalog* metadata
//! for that exact video — clean song title and real artist — for anything in
//! its catalog (official music videos, Topic audio uploads). This is the same
//! data the YT Music player UI shows, fetched unauthenticated. It covers the
//! common case yt-dlp can't anymore: official music videos, where the
//! "Music in this video" box moved into page data yt-dlp doesn't parse.

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicCredits {
    pub track: Option<String>,
    pub artist: Option<String>,
}

const EMPTY: MusicCredits = MusicCredits {
    track: None,
    artist: None,
};

/// musicVideoType values whose title/artist are real catalog credits.
/// UGC (user uploads) echoes the raw video title / channel name back — worse
/// than useless here, so anything not on this list returns no credits.
const CREDITED_TYPES: [&str; 3] = [
    "MUSIC_VIDEO_TYPE_OMV", // official music video
    "MUSIC_VIDEO_TYPE_ATV", // album/audio track ("Topic" upload)
    "MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC",
];

/// Fetch YouTube's own credits for a video, trying two sources:
/// 1. The YouTube Music catalog — canonical song/artist for official music
///    videos and album audio ("Topic" uploads).
/// 2. The watch page's "Music in this video" attribution (content-ID) — the
///    real song inside lyric videos and other reuploads, where the uploader
///    isn't the artist.
/// Returns None fields when neither source knows the video; errors only on
/// network/protocol failure so callers can tell "no credits" from
/// "couldn't check".
///
/// `video_title` is the raw video title the credits would replace. The
/// attribution source names whatever audio content-ID matched *inside* the
/// video — which can be a different edition or a plain wrong claim (a
/// "Ogryzek - Glory" reupload claimed as "AURA of GLORY (Slowed)"). So an
/// attribution title is only adopted when it CLEANS the raw title (the song
/// name already appears in it, and no edition marker like "slowed" gets
/// dropped); otherwise the title is kept and only the artist is taken. The
/// catalog source is exempt: it describes this exact videoId, not a match.
#[tauri::command]
pub async fn music_credits(
    video_id: String,
    video_title: String,
) -> Result<MusicCredits, String> {
    let id = video_id.trim().to_string();
    if id.is_empty() {
        return Ok(EMPTY);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    match catalog_credits(&client, &id).await {
        Ok(credits) if credits.track.is_some() || credits.artist.is_some() => {
            return Ok(credits)
        }
        _ => {}
    }

    let mut credits = attribution_credits(&client, &id).await?;
    if let Some(track) = &credits.track {
        if !title_cleans(&video_title, track) {
            credits.track = None;
        }
    }
    Ok(credits)
}

/// Words that change which recording a title names; a credited title may not
/// silently drop one the uploader put in the video title.
const EDITION_MARKERS: [&str; 17] = [
    "slowed", "sped up", "spedup", "speed up", "reverb", "nightcore", "8d",
    "remix", "mashup", "instrumental", "karaoke", "cover", "bass boost",
    "bassboost", "lofi", "lo fi", "extended",
];

/// True when adopting `credited` would only strip decoration from
/// `video_title`, not rename the track to something else.
fn title_cleans(video_title: &str, credited: &str) -> bool {
    let vt = normalize_title(video_title);
    let ct = normalize_title(credited);
    if ct.is_empty() || !contains_phrase(&vt, &ct) {
        return false;
    }
    EDITION_MARKERS
        .iter()
        .all(|m| !contains_phrase(&vt, m) || contains_phrase(&ct, m))
}

/// Lowercase; every run of non-alphanumeric characters becomes one space.
fn normalize_title(s: &str) -> String {
    let mut out = String::new();
    for ch in s.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    out.trim().to_string()
}

/// Whole-word phrase containment on normalized strings ("glory" must not
/// match inside "glorybox").
fn contains_phrase(haystack: &str, phrase: &str) -> bool {
    format!(" {haystack} ").contains(&format!(" {phrase} "))
}

/// Source 1: the YouTube Music watch queue for this exact videoId.
async fn catalog_credits(
    client: &reqwest::Client,
    id: &str,
) -> Result<MusicCredits, String> {
    let body = json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20250701.01.00",
                "hl": "en",
            }
        },
        "videoId": id,
    });

    let root = post_innertube(
        client,
        "https://music.youtube.com/youtubei/v1/next?prettyPrint=false",
        "https://music.youtube.com",
        body,
    )
    .await?;

    let Some(item) = find_queue_item(&root, id) else {
        return Ok(EMPTY);
    };

    let video_type = find_string(item, "musicVideoType");
    if !video_type.is_some_and(|t| CREDITED_TYPES.contains(&t)) {
        return Ok(EMPTY);
    }

    Ok(MusicCredits {
        track: first_run_text(item, "title"),
        artist: byline_artist(item),
    })
}

/// Source 2: the watch page's "Music in this video" attribution card
/// (content-ID). Present on lyric videos and reuploads YouTube has matched to
/// a song. Only trusted when the page has exactly one song card — a
/// compilation crediting many songs can't name the whole video.
async fn attribution_credits(
    client: &reqwest::Client,
    id: &str,
) -> Result<MusicCredits, String> {
    let body = json!({
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20250701.01.00",
                "hl": "en",
            }
        },
        "videoId": id,
    });

    let root = post_innertube(
        client,
        "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
        "https://www.youtube.com",
        body,
    )
    .await?;

    let mut cards = Vec::new();
    collect_song_cards(&root, &mut cards);
    if cards.len() != 1 {
        return Ok(EMPTY);
    }
    let card = cards[0];

    let track = string_field(card, "title");
    let artist = string_field(card, "subtitle");
    if track.is_none() || artist.is_none() {
        return Ok(EMPTY);
    }
    Ok(MusicCredits { track, artist })
}

async fn post_innertube(
    client: &reqwest::Client,
    url: &str,
    origin: &str,
    body: Value,
) -> Result<Value, String> {
    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .header("origin", origin)
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("YouTube lookup failed: HTTP {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Collect attribution cards that credit a song. Cards carry a "Song credits"
/// detail dialog; one without any dialog is accepted too, but a card whose
/// dialog is titled something else is not a song credit.
fn collect_song_cards<'a>(v: &'a Value, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(map) => {
            if let Some(card) = map.get("videoAttributeViewModel") {
                match dialog_title(card) {
                    Some(title) if title != "Song credits" => {}
                    _ => out.push(card),
                }
            }
            for x in map.values() {
                collect_song_cards(x, out);
            }
        }
        Value::Array(arr) => {
            for x in arr {
                collect_song_cards(x, out);
            }
        }
        _ => {}
    }
}

/// Title of the card's confirm dialog ("Song credits"), if it has one.
fn dialog_title(card: &Value) -> Option<String> {
    let dialog = find_object(card, "confirmDialogRenderer")?;
    let runs = dialog.get("title")?.get("runs")?.as_array()?;
    Some(
        runs.iter()
            .filter_map(|r| r.get("text").and_then(Value::as_str))
            .collect::<String>(),
    )
}

/// Depth-first search for the first object stored under `key`.
fn find_object<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Object(map) => {
            if let Some(o) = map.get(key) {
                return Some(o);
            }
            map.values().find_map(|x| find_object(x, key))
        }
        Value::Array(arr) => arr.iter().find_map(|x| find_object(x, key)),
        _ => None,
    }
}

fn string_field(v: &Value, key: &str) -> Option<String> {
    let s = v.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// Depth-first search for the watch-queue entry describing `video_id`.
fn find_queue_item<'a>(v: &'a Value, video_id: &str) -> Option<&'a Value> {
    match v {
        Value::Object(map) => {
            if let Some(r) = map.get("playlistPanelVideoRenderer") {
                if r.get("videoId").and_then(Value::as_str) == Some(video_id) {
                    return Some(r);
                }
            }
            map.values().find_map(|x| find_queue_item(x, video_id))
        }
        Value::Array(arr) => arr.iter().find_map(|x| find_queue_item(x, video_id)),
        _ => None,
    }
}

/// Depth-first search for the first string value under `key`.
fn find_string<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    match v {
        Value::Object(map) => {
            if let Some(s) = map.get(key).and_then(Value::as_str) {
                return Some(s);
            }
            map.values().find_map(|x| find_string(x, key))
        }
        Value::Array(arr) => arr.iter().find_map(|x| find_string(x, key)),
        _ => None,
    }
}

fn first_run_text(item: &Value, field: &str) -> Option<String> {
    let s = item
        .get(field)?
        .get("runs")?
        .get(0)?
        .get("text")?
        .as_str()?
        .trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// The byline reads "Artist • Album • Year" (or "Artist • views • likes").
/// Multiple artists span several runs ("A", " & ", "B") before the first "•"
/// separator — join everything up to it.
fn byline_artist(item: &Value) -> Option<String> {
    let runs = item.get("longBylineText")?.get("runs")?.as_array()?;
    let mut artist = String::new();
    for run in runs {
        let text = run.get("text").and_then(Value::as_str).unwrap_or("");
        if text.trim() == "•" {
            break;
        }
        artist.push_str(text);
    }
    let artist = artist.trim();
    (!artist.is_empty()).then(|| artist.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_cleans_strips_decoration_only() {
        // Cleaning: song name already inside the video title.
        assert!(title_cleans("Bôa - Duvet (Lyrics)", "Duvet"));
        assert!(title_cleans("Never gonna give you up lyrics", "Never Gonna Give You Up"));
        // Renaming: a different song identity must be rejected.
        assert!(!title_cleans("Ogryzek - Glory", "AURA of GLORY (Slowed)"));
        // Dropping an edition marker the uploader wrote must be rejected.
        assert!(!title_cleans("Ogryzek - Glory (Slowed)", "Glory"));
        // Word boundaries: "Glory" is not inside "Glorybox".
        assert!(!title_cleans("Portishead - Glorybox", "Glory"));
    }

    // Live network test (hits YouTube): cargo test live_credits -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_credits() {
        let cases = [
            // (id, video title, what it is, expected track, expected artist)
            (
                "dQw4w9WgXcQ",
                "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
                "official music video",
                Some("Never Gonna Give You Up"),
                Some("Rick Astley"),
            ),
            (
                "Ava0duwBsZo",
                "Bôa - Duvet (Lyrics)",
                "lyric-channel reupload",
                Some("Duvet"),
                Some("bôa"),
            ),
            // Content-ID claims a different song ("AURA of GLORY (Slowed)");
            // the raw title must survive, the artist may correct.
            (
                "YVzLizz3k78",
                "Ogryzek - Glory",
                "reupload with mismatched claim",
                None,
                Some("Ogryzek"),
            ),
            // Non-music video: must yield nothing rather than fake credits.
            ("jNQXAC9IVRw", "Me at the zoo", "non-music", None, None),
        ];
        for (id, title, what, track, artist) in cases {
            let got =
                tauri::async_runtime::block_on(music_credits(id.into(), title.into())).unwrap();
            println!("{id} ({what}): {:?} / {:?}", got.track, got.artist);
            assert_eq!(got.track.as_deref(), track, "{what}");
            assert_eq!(got.artist.as_deref(), artist, "{what}");
        }
    }
}
