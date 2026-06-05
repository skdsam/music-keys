mod analysis;
mod commands;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_folder,
            commands::analyze_sample,
            commands::export_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sample Key Studio");
}

fn main() {
    run();
}
