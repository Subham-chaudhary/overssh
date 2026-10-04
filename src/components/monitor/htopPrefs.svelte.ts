// Persisted htop tab preferences (§14.4.H). UI-only, so plain localStorage
// (every access wrapped: it can throw or come back empty in previews/private mode).
import { COLUMNS, DEFAULT_COLUMNS, type SortKey } from "./htop";

const KEY = "overssh.htop.v1";
const VALID = new Set<string>(COLUMNS.map((c) => c.key));

interface Saved {
  columns: SortKey[];
  sortKey: SortKey;
  desc: boolean;
  tree: boolean;
  hideKernel: boolean;
  threads: boolean;
  meters: boolean;
}

class HtopPrefs {
  columns = $state<SortKey[]>([...DEFAULT_COLUMNS]);
  sortKey = $state<SortKey>("cpu");
  desc = $state(true);
  tree = $state(false);
  hideKernel = $state(true);
  threads = $state(false);
  meters = $state(true);

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<Saved>;
      if (Array.isArray(s.columns)) {
        const cols = s.columns.filter((k) => VALID.has(k));
        // Command is the flexible column; it can never be hidden.
        if (!cols.includes("command")) cols.push("command");
        if (cols.length > 1) this.columns = cols;
      }
      if (s.sortKey && VALID.has(s.sortKey)) this.sortKey = s.sortKey;
      if (typeof s.desc === "boolean") this.desc = s.desc;
      if (typeof s.tree === "boolean") this.tree = s.tree;
      if (typeof s.hideKernel === "boolean") this.hideKernel = s.hideKernel;
      if (typeof s.threads === "boolean") this.threads = s.threads;
      if (typeof s.meters === "boolean") this.meters = s.meters;
    } catch {
      /* defaults */
    }
  }

  save(): void {
    try {
      const s: Saved = {
        columns: [...this.columns],
        sortKey: this.sortKey,
        desc: this.desc,
        tree: this.tree,
        hideKernel: this.hideKernel,
        threads: this.threads,
        meters: this.meters,
      };
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }

  toggleColumn(key: SortKey): void {
    if (key === "command") return;
    this.columns = this.columns.includes(key) ? this.columns.filter((k) => k !== key) : [...this.columns, key];
    this.save();
  }

  resetColumns(): void {
    this.columns = [...DEFAULT_COLUMNS];
    this.save();
  }
}

export const htopPrefs = new HtopPrefs();
