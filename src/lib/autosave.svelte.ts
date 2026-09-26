// Autosave (docs/GUIDE.md §11 "Autosave"): implements `settings.files.autoSave`
// modes 'afterDelay' / 'onFocusChange' / 'onWindowChange'. Always saves via
// `app.saveTab(id, false, { auto: true })` — the same path as Ctrl+S, so the
// conflict check always runs; `auto: true` makes it silent (no toast, no sudo
// prompt) and a no-op while a save is already in flight, a conflict is
// pending, or the tab is autosave-paused (see stores.svelte.ts's `saveTab`).
//
// Wired from Editor.svelte (per-doc-change scheduling, editor blur) and
// installed once, eagerly, at module scope (window blur — see the bottom of
// this file) so it keeps working even while no `<Editor>` is mounted (e.g.
// the active workspace has zero tabs open, per App.svelte's `{#if
// tabs.length === 0}`).

import { app, type Tab } from "./stores.svelte";
import { settings } from "./settings.svelte";

function isDirty(tab: Tab): boolean {
  return tab.doc !== tab.savedDoc;
}

function saveAuto(tabId: string): void {
  void app.saveTab(tabId, false, { auto: true });
}

function findTab(tabId: string): Tab | null {
  for (const ws of Object.values(app.workspaces)) {
    const t = ws.tabs.find((x) => x.id === tabId);
    if (t) return t;
  }
  return null;
}

const delayTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 'afterDelay' mode: call after every model content change for `tab`.
 * (Re)starts a per-tab debounce of `settings.files.autoSaveDelay` ms; a no-op
 * when that isn't the active mode, or the tab has nothing to save. */
export function scheduleAfterDelay(tab: Tab): void {
  const existing = delayTimers.get(tab.id);
  if (existing) {
    clearTimeout(existing);
    delayTimers.delete(tab.id);
  }
  if (settings.files.autoSave !== "afterDelay" || !isDirty(tab)) return;
  const tabId = tab.id;
  const timer = setTimeout(() => {
    delayTimers.delete(tabId);
    const t = findTab(tabId);
    if (t && settings.files.autoSave === "afterDelay" && isDirty(t)) saveAuto(tabId);
  }, Math.max(0, settings.files.autoSaveDelay));
  delayTimers.set(tab.id, timer);
}

/** Clears any pending 'afterDelay' timer for a tab. Call when the tab closes
 * (its model is disposed) so a stale timer never fires against a gone tab. */
export function cancelAutosave(tabId: string): void {
  const timer = delayTimers.get(tabId);
  if (timer) clearTimeout(timer);
  delayTimers.delete(tabId);
}

/** 'onFocusChange' mode: the Monaco editor itself lost text focus (e.g. the
 * user clicked the sidebar or terminal panel) without necessarily switching
 * tabs. Saves `tabId` if it's still dirty. */
export function onEditorBlur(tabId: string | null): void {
  if (!tabId || settings.files.autoSave !== "onFocusChange") return;
  const t = findTab(tabId);
  if (t && isDirty(t)) saveAuto(tabId);
}

/** 'onFocusChange' mode: call with the *previous* active tab id right before
 * switching to a different tab (in the same or a different workspace) — VS
 * Code treats an editor-group/tab switch as a focus change too. */
export function onActiveTabLeave(previousTabId: string | null): void {
  if (!previousTabId || settings.files.autoSave !== "onFocusChange") return;
  const t = findTab(previousTabId);
  if (t && isDirty(t)) saveAuto(previousTabId);
}

/** 'onWindowChange' mode: the OS window itself lost focus (`window`'s
 * `blur` event) — saves every dirty tab across every workspace. Installed
 * once at module load (below), not tied to any component's lifecycle. */
function onWindowBlur(): void {
  if (settings.files.autoSave !== "onWindowChange") return;
  for (const ws of Object.values(app.workspaces)) {
    for (const t of ws.tabs) {
      if (isDirty(t)) saveAuto(t.id);
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("blur", onWindowBlur);
}
