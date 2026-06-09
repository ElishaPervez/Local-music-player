mod commands;
mod ytdlp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ytdlp::ytdlp_version,
            ytdlp::search,
            ytdlp::resolve_stream,
            ytdlp::download_song,
            ytdlp::update_ytdlp,
            commands::default_library_dir,
            commands::delete_file,
            commands::import_background,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
