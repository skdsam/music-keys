mod analysis;
mod commands;
mod db;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_folder,
            commands::scan_files,
            commands::load_library,
            commands::clear_library,
            commands::save_sample_metadata,
            commands::analyze_sample,
            commands::export_results,
            commands::open_file_location,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sample Key Studio");
}

fn main() {
    run();
}
