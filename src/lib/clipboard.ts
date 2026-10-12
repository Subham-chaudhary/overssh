/** System clipboard through the Tauri plugin. WebKit (macOS, Linux) shows a
 * "Paste" callout for `navigator.clipboard.readText` and can reject writes made
 * after an `await`; the plugin has neither problem. Falls back to the web API
 * outside Tauri. */
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export async function clipboardRead(): Promise<string> {
  try {
    const text = await readText();
    if (typeof text === "string") return text;
  } catch {
    // not in Tauri, or the clipboard holds no text
  }
  return navigator.clipboard.readText();
}

export async function clipboardWrite(text: string): Promise<void> {
  try {
    await writeText(text);
    return;
  } catch {
    // not in Tauri
  }
  await navigator.clipboard.writeText(text);
}
