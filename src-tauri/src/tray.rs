//! System tray: keeps running port forwards alive after the main window is
//! closed (docs/GUIDE.md §13.4.P). The tray menu lists running tunnels (click =
//! stop), "Stop all tunnels", "Show OverSSH" and "Quit".

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::forward::ForwardManager;

const TRAY_ID: &str = "main";

fn build_menu(app: &AppHandle, tunnels: &[(String, String)]) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", "Show OverSSH", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if tunnels.is_empty() {
        menu.append(&MenuItem::with_id(app, "none", "No tunnels running", false, None::<&str>)?)?;
    } else {
        for (id, label) in tunnels {
            menu.append(&MenuItem::with_id(
                app,
                format!("stop:{id}"),
                format!("Stop  {label}"),
                true,
                None::<&str>,
            )?)?;
        }
        menu.append(&MenuItem::with_id(app, "stop_all", "Stop all tunnels", true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Builds the tray icon. Called once from `lib.rs` setup.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let menu = build_menu(app.handle(), &[])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("OverSSH")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn handle_menu(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "show" => show_main(app),
        "quit" => app.exit(0),
        "stop_all" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mgr = app.state::<ForwardManager>().inner().clone();
                mgr.stop_all(&app).await;
            });
        }
        other => {
            if let Some(fid) = other.strip_prefix("stop:") {
                let app = app.clone();
                let fid = fid.to_string();
                tauri::async_runtime::spawn(async move {
                    let mgr = app.state::<ForwardManager>().inner().clone();
                    mgr.stop_one(&app, &fid).await;
                });
            }
        }
    }
}

/// Rebuilds the tray menu + tooltip from the currently running forwards.
pub async fn refresh(app: &AppHandle, mgr: &ForwardManager) {
    let tunnels = mgr.labels().await;
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    if let Ok(menu) = build_menu(app, &tunnels) {
        let _ = tray.set_menu(Some(menu));
    }
    let tip = if tunnels.is_empty() {
        "OverSSH".to_string()
    } else {
        format!("OverSSH - {} tunnel(s) running", tunnels.len())
    };
    let _ = tray.set_tooltip(Some(tip));
}
