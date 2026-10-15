mod appicon;
mod closeguard;
mod commands;
mod cron;
mod diskusage;
mod docker;
mod error;
mod forward;
mod git;
mod localfs;
mod monitor;
mod recording;
mod logs;
mod search;
mod session;
mod sftp;
mod ssh_config;
mod store;
mod systemd;
mod terminal;
mod transfer;
mod tray;

use session::SessionManager;
use terminal::TerminalManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer shows a blank window on many NVIDIA and
    // VM setups. Opt out unless the user chose a value themselves.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(SessionManager::new())
        .manage(TerminalManager::new())
        .manage(std::sync::Arc::new(monitor::MonitorManager::new()))
        .manage(logs::LogManager::new())
        .manage(forward::ForwardManager::new())
        .manage(search::SearchManager::new())
        .manage(transfer::TransferManager::new())
        .manage(diskusage::DuManager::new())
        .manage(docker::DockerManager::new())
        .setup(|app| {
            // No tray (e.g. a Linux desktop without a status area) is not a
            // reason to refuse to start; closing then simply quits (below).
            if let Err(_e) = tray::setup(app) {
                #[cfg(debug_assertions)]
                eprintln!("tray unavailable: {_e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            terminal::on_window_event(window, event);
            if let tauri::WindowEvent::Destroyed = event {
                appicon::on_window_destroyed(window);
            }
            // Keep running tunnels alive: hide to the tray instead of quitting.
            // A real close asks the frontend about unsaved files first (closeguard.rs).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    use tauri::Manager;
                    // Hiding without a tray icon would leave no way back to the window.
                    let has_tray = window.app_handle().tray_by_id("main").is_some();
                    if has_tray && window.app_handle().state::<forward::ForwardManager>().should_hide_on_close() {
                        api.prevent_close();
                        closeguard::clear_confirmation();
                        let _ = window.hide();
                    } else if !closeguard::allow_close(window) {
                        api.prevent_close();
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
            docker::docker_run,
            docker::docker_logs_start,
            docker::docker_logs_stop,
            docker::docker_stats_start,
            docker::docker_stats_stop,
            docker::docker_events_start,
            docker::docker_events_stop,
            diskusage::du_start,
            diskusage::du_cancel,
            store::load_store,
            store::save_store,
            forward::forward_start,
            forward::forward_stop,
            forward::forward_list,
            forward::forward_set_close_to_tray,
            session::session_ping,
            systemd::systemd_probe,
            systemd::systemd_list,
            systemd::systemd_timers,
            systemd::systemd_failed,
            systemd::systemd_show,
            systemd::systemd_stats,
            systemd::systemd_text,
            systemd::systemd_action,
            localfs::local_write_text,
            localfs::local_read_text,
            appicon::set_taskbar_icon,
            closeguard::confirm_close,
            closeguard::app_quit,
            closeguard::quit_cancelled,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // macOS: clicking the Dock icon brings back a main window that was
            // hidden to the tray.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = _event {
                use tauri::Manager;
                if let Some(w) = _app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
}
