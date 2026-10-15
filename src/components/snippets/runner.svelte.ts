// Snippet runner + shared dialog state (docs/GUIDE.md §13.4.N).
// `snippetUi` is read by the dialogs rendered inside CommandHistory.svelte.
import { clipboardRead, clipboardWrite } from "$lib/clipboard";
import * as api from "../../lib/api";
import { isAppError } from "../../lib/api";
import { app } from "../../lib/stores.svelte";
import { terminalStore } from "../../lib/terminal.svelte";
import { markSnippetUsed, record } from "../../lib/history.svelte";
import type { Snippet } from "../../lib/types";
import {
  extractVariables,
  formatDate,
  isSecretName,
  parseTemplate,
  renderTemplate,
  usedBuiltins,
  type BuiltinName,
} from "./template";

export type RunMode = "run" | "new" | "insert" | "copy";

class SnippetUi {
  /** Snippet whose variable form is open. */
  run = $state<{ snippet: Snippet; builtins: Partial<Record<BuiltinName, string>> } | null>(null);
  /** Edit dialog: a snippet, "new" (with optional prefill), or closed. */
  edit = $state<{ snippet: Snippet | null; prefill?: Partial<Snippet> } | null>(null);
  picker = $state(false);
  importOpen = $state(false);
}
export const snippetUi = new SnippetUi();

export function currentHost(): string | null {
  const s = app.activeSession;
  return s ? `${s.user}@${s.hostname}` : null;
}

/** Resolves built-ins for the active session (clipboard read is async and
 * only attempted when `needed` includes it). */
export async function resolveBuiltins(needed: readonly BuiltinName[]): Promise<Partial<Record<BuiltinName, string>>> {
  const out: Partial<Record<BuiltinName, string>> = {};
  const session = app.activeSession;
  if (needed.includes("host")) out.host = session?.hostname ?? "";
  if (needed.includes("user")) out.user = session?.user ?? "";
  if (needed.includes("cwd")) {
    out.cwd = (session && app.workspaces[session.id]?.explorer.cwd) || session?.home || "";
  }
  if (needed.includes("date")) out.date = formatDate(new Date());
  if (needed.includes("clipboard")) {
    try {
      out.clipboard = await clipboardRead();
    } catch {
      out.clipboard = "";
    }
  }
  return out;
}

/** Entry point for every "run this snippet" action. Variables -> form;
 * otherwise (built-ins only) runs immediately in the active terminal. */
export async function startRun(snippet: Snippet, mode: RunMode = "run"): Promise<void> {
  const tokens = parseTemplate(snippet.cmd);
  const builtins = await resolveBuiltins(usedBuiltins(tokens));
  if (extractVariables(tokens).length > 0) {
    snippetUi.run = { snippet, builtins };
    return;
  }
  await execute(snippet, renderTemplate(tokens, {}, builtins), mode, {});
}

async function ensureTargetTerminal(): Promise<string | null> {
  const sessionId = app.activeSessionId;
  if (!sessionId) {
    app.addToast("error", "Connect to a host first");
    return null;
  }
  const existing =
    terminalStore.tabs.find((t) => t.id === terminalStore.activeId && t.sessionId === sessionId) ??
    terminalStore.tabs.find((t) => t.sessionId === sessionId);
  if (existing) {
    app.showTerminal = true;
    terminalStore.setActive(existing.id);
    return existing.id;
  }
  const cwd = app.workspaces[sessionId]?.explorer.cwd;
  try {
    return await terminalStore.openNew(sessionId, { cwd });
  } catch (err) {
    app.addToast("error", isAppError(err) ? err.message : String(err));
    return null;
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    await clipboardWrite(text);
    app.addToast("info", "Copied to clipboard");
  } catch {
    app.addToast("error", "Clipboard access denied");
  }
}

/** Performs `mode` with the final command text. `snippet` may be null for
 * ad-hoc history entries. */
export async function execute(
  snippet: Snippet | null,
  command: string,
  mode: RunMode,
  values: Record<string, string>,
): Promise<boolean> {
  // A secret typed into a variable must not end up in the snippet store or the command history.
  const secret = Object.keys(values).some(isSecretName);
  const remembered = Object.fromEntries(Object.entries(values).filter(([k]) => !isSecretName(k)));
  if (mode === "copy") {
    await copyText(command);
    if (snippet) markSnippetUsed(snippet.id, remembered);
    return true;
  }
  const sessionId = app.activeSessionId;
  const host = currentHost();
  if (!sessionId || !host) {
    app.addToast("error", "Connect to a host first");
    return false;
  }
  try {
    if (mode === "new") {
      const cwd = app.workspaces[sessionId]?.explorer.cwd;
      await terminalStore.openNew(sessionId, { command, title: command.split("\n")[0], cwd });
      if (!secret) record(host, command);
    } else {
      const id = await ensureTargetTerminal();
      if (!id) return false;
      if (mode === "run") {
        await api.termWrite(id, command + "\r");
        if (!secret) record(host, command);
      } else {
        await api.termWrite(id, command);
      }
    }
    if (snippet) markSnippetUsed(snippet.id, remembered);
    return true;
  } catch (err) {
    app.addToast("error", isAppError(err) ? err.message : String(err));
    return false;
  }
}
