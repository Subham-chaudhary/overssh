/** Host OS checks and the platform's primary shortcut modifier.
 * macOS uses Cmd for app shortcuts and leaves Ctrl to the shell (Ctrl+W,
 * Ctrl+B, ... are readline keys there). Windows and Linux use Ctrl. */

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isMac = /Mac OS X|Macintosh/.test(ua);
export const isLinux = !isMac && /Linux|X11/.test(ua);

/** True when the platform's shortcut modifier is held (Cmd on macOS, Ctrl elsewhere;
 * Meta is also accepted off macOS, as before). */
export function modKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey || e.metaKey;
}

/** Shows a "Ctrl+Shift+P" style binding in the platform's notation (⇧⌘P on macOS). */
export function formatShortcut(binding: string): string {
  return formatShortcutFor(binding, isMac);
}

export function formatShortcutFor(binding: string, mac: boolean): string {
  if (!mac) return binding;
  const parts = binding.split("+");
  // A trailing "+" key ("Ctrl++") splits into an empty last part.
  const key = parts.length > 1 && parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).filter(Boolean).map((m) => m.toLowerCase()));
  let out = "";
  if (mods.has("ctrl") && mods.has("meta")) out += "⌃";
  if (mods.has("alt")) out += "⌥";
  if (mods.has("shift")) out += "⇧";
  if (mods.has("ctrl") || mods.has("cmd") || mods.has("meta")) out += "⌘";
  return out + key;
}
