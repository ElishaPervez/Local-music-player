mod bgutil;
mod commands;
mod credits;
mod discord;
mod setup;
mod stream_proxy;
mod youtube_cookies;
mod ytdlp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(discord::DiscordState::default())
        .manage(bgutil::PotProvider::default())
        .setup(|app| {
            // Streamed playback goes through a loopback proxy (see
            // stream_proxy.rs). If it can't start, local playback and
            // downloads still work; resolve_stream falls back to direct
            // URLs (which the webview may refuse to play).
            match stream_proxy::StreamProxy::start() {
                Ok(proxy) => {
                    use tauri::Manager;
                    app.manage(proxy);
                }
                Err(error) => eprintln!("stream proxy failed to start: {error}"),
            }
            // Bring up the YouTube PO-token provider in the background
            // (see bgutil.rs). Until it reports healthy, yt-dlp runs
            // without tokens — the pre-existing behavior.
            bgutil::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ytdlp::ytdlp_version,
            ytdlp::search,
            ytdlp::related_mix,
            ytdlp::resolve_stream,
            ytdlp::download_song,
            ytdlp::verify_youtube_cookies,
            credits::music_credits,
            ytdlp::update_ytdlp,
            commands::default_library_dir,
            commands::delete_file,
            commands::import_background,
            setup::tools_status,
            setup::install_ffmpeg,
            youtube_cookies::youtube_cookie_status,
            youtube_cookies::import_youtube_cookies,
            youtube_cookies::import_youtube_cookies_text,
            youtube_cookies::remove_youtube_cookies,
            discord::discord_set_presence,
            discord::discord_clear,
            discord::discord_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
