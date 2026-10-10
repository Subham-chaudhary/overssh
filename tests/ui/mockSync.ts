// Fake local file access for settings sync (docs/GUIDE.md §15.3.Y): the real
// `local_write_text` / `local_read_text` open a native dialog. Scenarios drive it
// through `window.__sync`.
export interface SyncMockState {
  writes: { suggestedName: string; text: string }[];
  /** What the open dialog returns next; null = cancelled. */
  nextRead: { path: string; text: string } | null;
  /** True: the save dialog is cancelled. */
  cancelWrite: boolean;
}

const state: SyncMockState = { writes: [], nextRead: null, cancelWrite: false };

declare global {
  interface Window {
    __sync: {
      writes: () => { suggestedName: string; text: string }[];
      setNextRead: (v: { path: string; text: string } | null) => void;
      setCancelWrite: (v: boolean) => void;
    };
  }
}

window.__sync = {
  writes: () => state.writes.map((w) => ({ ...w })),
  setNextRead: (v) => {
    state.nextRead = v;
  },
  setCancelWrite: (v) => {
    state.cancelWrite = v;
  },
};

/** Returns `undefined` for commands this fake does not own. */
export function syncCommand(cmd: string, args: Record<string, unknown>): unknown {
  if (cmd === "local_write_text") {
    if (state.cancelWrite) return null;
    const text = String(args.text ?? "");
    let ok = false;
    try {
      ok = (JSON.parse(text) as { format?: string }).format === "overssh-settings";
    } catch {
      ok = false;
    }
    if (!ok) throw { kind: "Config", message: "not an OverSSH settings export" };
    state.writes.push({ suggestedName: String(args.suggestedName ?? ""), text });
    return `C:\Users\test\${String(args.suggestedName ?? "overssh-settings.json")}`;
  }
  if (cmd === "local_read_text") {
    const r = state.nextRead;
    state.nextRead = null;
    return r;
  }
  return undefined;
}
