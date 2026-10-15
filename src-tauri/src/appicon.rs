//! Taskbar icon on Windows.
//!
//! Tauri's `setIcon` reaches tao's `set_window_icon`, which sets only the small
//! icon (`WM_SETICON ICON_SMALL`: title bar, Alt+Tab). The taskbar button uses
//! the big icon, which tao sets once when the window is created. So a themed
//! icon never reached the taskbar. This command sets `ICON_BIG` too.
//! Other platforms: a no-op (Linux uses the `setIcon` icon; macOS has no window icon).

#[cfg(windows)]
mod win {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateIcon, DestroyIcon, SendMessageW, HICON, ICON_BIG, WM_SETICON};

    /// The big icon this module set last, per window (as usize: HICON is a raw pointer).
    /// Only icons created here are destroyed; tao owns the one it set at creation.
    static OURS: Mutex<Option<HashMap<isize, usize>>> = Mutex::new(None);

    /// RGBA (straight alpha) -> HICON, as tao does: BGRA colour bits plus an AND mask.
    fn create_icon(rgba: &[u8], width: u32, height: u32) -> Option<HICON> {
        let n = (width * height) as usize;
        if width == 0 || height == 0 || width > 512 || height > 512 || rgba.len() != n * 4 {
            return None;
        }
        let mut bgra = rgba.to_vec();
        let mut and_mask = Vec::with_capacity(n);
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
            and_mask.push(px[3].wrapping_sub(u8::MAX));
        }
        let icon = unsafe {
            CreateIcon(std::ptr::null_mut(), width as i32, height as i32, 1, 32, and_mask.as_ptr(), bgra.as_ptr())
        };
        (!icon.is_null()).then_some(icon)
    }

    pub fn set_big_icon(hwnd: isize, rgba: &[u8], width: u32, height: u32) -> bool {
        let Some(icon) = create_icon(rgba, width, height) else { return false };
        unsafe {
            SendMessageW(hwnd as _, WM_SETICON, ICON_BIG as usize, icon as isize);
        }
        let mut guard = OURS.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(old) = map.insert(hwnd, icon as usize) {
            unsafe {
                DestroyIcon(old as HICON);
            }
        }
        true
    }

    /// Frees the icon of a window that is gone.
    pub fn forget(hwnd: isize) {
        let mut guard = OURS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = guard.as_mut().and_then(|m| m.remove(&hwnd)) {
            unsafe {
                DestroyIcon(old as HICON);
            }
        }
    }
}

/// Sets the taskbar (big) icon of the calling window from RGBA pixels.
/// Sync command: runs on the main thread, which owns the window.
#[tauri::command]
pub fn set_taskbar_icon(window: tauri::WebviewWindow, rgba: Vec<u8>, width: u32, height: u32) -> bool {
    #[cfg(windows)]
    {
        match window.hwnd() {
            Ok(h) => win::set_big_icon(h.0 as isize, &rgba, width, height),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, rgba, width, height);
        false
    }
}

/// Called when a window is destroyed.
pub fn on_window_destroyed(window: &tauri::Window) {
    #[cfg(windows)]
    if let Ok(h) = window.hwnd() {
        win::forget(h.0 as isize);
    }
    #[cfg(not(windows))]
    let _ = window;
}
