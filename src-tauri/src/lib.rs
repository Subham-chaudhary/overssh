mod commands;
mod cron;
mod diskusage;
mod error;
mod forward;
mod git;
mod monitor;
mod recording;
mod logs;
mod search;
mod session;
mod sftp;
mod ssh_config;
mod store;
mod terminal;
mod transfer;
mod tray;

use session::SessionManager;
use terminal::TerminalManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::new())
        .manage(TerminalManager::new())
        .manage(std::sync::Arc::new(monitor::MonitorManager::new()))
        .manage(logs::LogManager::new())
        .manage(forward::ForwardManager::new())
        .manage(search::SearchManager::new())
        .manage(transfer::TransferManager::new())
        .manage(diskusage::DuManager::new())
        .setup(|app| {
            tray::setup(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            terminal::on_window_event(window, event);
            // Keep running tunnels alive: hide to the tray instead of quitting.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    use tauri::Manager;
                    if window.app_handle().state::<forward::ForwardManager>().should_hide_on_close() {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_hosts,
            commands::connect,
            commands::disconnect,
            commands::list_dir,
            commands::stat,
            commands::file_info,
            commands::dir_size,
            commands::read_file,
            commands::write_file,
            commands::write_file_sudo,
            commands::create_file,
            commands::create_dir,
            commands::rename,
            commands::copy_path,
            commands::remove,
            commands::download,
            commands::upload,
            transfer::transfer_start,
            transfer::transfer_cancel,
            transfer::transfer_resolve,
            commands::term_open,
            commands::term_write,
            commands::term_resize,
            commands::term_close,
            terminal::term_snapshot,
            terminal::term_window_open,
            terminal::term_window_focus,
            terminal::term_window_close,
            recording::rec_default_dir,
            recording::rec_start,
            recording::rec_stop,
            recording::rec_list,
            recording::rec_delete,
            recording::rec_read,
            recording::rec_reveal,
            logs::logs_open,
            logs::logs_close,
            logs::logs_discover,
            logs::logs_export,
            monitor::monitor_start,
            monitor::monitor_stop,
            monitor::proc_kill,
            monitor::proc_renice,
            monitor::proc_kill_many,
            monitor::proc_details,
            search::search_start,
            search::search_cancel,
            cron::cron_read,
            cron::cron_write,
            git::git_run,
            diskusage::du_start,
            diskusage::du_cancel,
            store::load_store,
            store::save_store,
            forward::forward_start,
            forward::forward_stop,
            forward::forward_list,
            forward::forward_set_close_to_tray,
            session::session_ping,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
