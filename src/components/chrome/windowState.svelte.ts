// Reactive native-window state for the custom title bar (docs/GUIDE.md §15.3.T).
import { onWinResized, winIsMaximized } from "../../lib/api";

export const windowState = $state({ maximized: false, focused: true });

async function sync(): Promise<void> {
  try {
    windowState.maximized = await winIsMaximized();
  } catch {
    /* not in Tauri */
  }
}

/** Starts tracking maximized / focus state. Returns a cleanup function. */
export function trackWindowState(): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  let raf = 0;

  void sync();
  void onWinResized(() => {
    // Resize events come in bursts while dragging an edge: check once per frame.
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => void sync());
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});

  const onFocus = () => {
    windowState.focused = true;
    // Maximize / restore done while unfocused (Win+Up from the taskbar, snap) may
    // not have sent a resize this window saw: re-read the real state.
    void sync();
  };
  const onBlur = () => (windowState.focused = false);
  windowState.focused = document.hasFocus();
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    unlisten?.();
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  };
}
