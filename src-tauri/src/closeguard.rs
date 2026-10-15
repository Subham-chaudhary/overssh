//! Unsaved-edits guard for every way the app can close.
//!
//! The title-bar close button asks first (`app.confirmQuit` in the frontend), but
//! Alt+F4, the taskbar "Close window" and the tray's Quit go straight to the OS.
//! They now ask the frontend first:
//! - Window close of `main` (when it would really close, not hide to the tray):
//!   prevented, then `app://close-requested` is sent. The frontend asks about
//!   unsaved files and calls `confirm_close`, which lets the next close through.
//! - Tray Quit: shows the window and sends `app://quit-requested`; the frontend
//!   asks and calls `app_quit`. A second Quit while the first is unanswered quits
//!   at once, so a frozen page can never keep the app from quitting.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

/// The next close of `main` was confirmed by the frontend.
static CLOSE_CONFIRMED: AtomicBool = AtomicBool::new(false);
/// A tray Quit is waiting for the frontend's answer.
static QUIT_PENDING: AtomicBool = AtomicBool::new(false);

/// Called on `CloseRequested` for `main` when the window would really close.
/// Returns true when the close may go ahead.
pub fn allow_close(window: &tauri::Window) -> bool {
    if CLOSE_CONFIRMED.swap(false, Ordering::SeqCst) {
        return true;
    }
    let _ = window.emit_to("main", "app://close-requested", ());
    false
}

/// Consumes a stale confirmation (the close turned into hide-to-tray instead).
pub fn clear_confirmation() {
    CLOSE_CONFIRMED.store(false, Ordering::SeqCst);
}

/// Tray Quit.
pub fn request_quit(app: &AppHandle) {
    if QUIT_PENDING.swap(true, Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    crate::tray::show_main(app);
    if app.emit_to("main", "app://quit-requested", ()).is_err() || app.get_webview_window("main").is_none() {
        app.exit(0);
    }
}

/// The user confirmed (or nothing was unsaved): close the main window.
#[tauri::command]
pub fn confirm_close(window: tauri::WebviewWindow) {
    CLOSE_CONFIRMED.store(true, Ordering::SeqCst);
    let _ = window.close();
}

/// The user confirmed a tray Quit.
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// The user cancelled a tray Quit.
#[tauri::command]
pub fn quit_cancelled() {
    QUIT_PENDING.store(false, Ordering::SeqCst);
}
