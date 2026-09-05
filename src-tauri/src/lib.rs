mod commands;
mod error;
mod session;
mod sftp;
mod ssh_config;
mod terminal;

use session::SessionManager;
use terminal::TerminalManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::new())
        .manage(TerminalManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::list_hosts,
            commands::connect,
            commands::disconnect,
            commands::list_dir,
            commands::stat,
            commands::read_file,
            commands::write_file,
            commands::write_file_sudo,
            commands::create_file,
            commands::create_dir,
            commands::rename,
            commands::remove,
            commands::download,
            commands::upload,
            commands::term_open,
            commands::term_write,
            commands::term_resize,
            commands::term_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
