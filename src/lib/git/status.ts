// Pure parser + grouping for `git status --porcelain=v2 --branch -z`
// (docs/GUIDE.md §14.4.G1). No Svelte, no I/O: unit tested in tests/unit.

export interface BranchStatus {
  /** Commit id of HEAD; null on an unborn branch ("(initial)"). */
  oid: string | null;
  /** Branch name; null when HEAD is detached. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export type EntryKind = "ordinary" | "rename" | "copy" | "unmerged" | "untracked" | "ignored";

export interface StatusEntry {
  kind: EntryKind;
  path: string;
  /** Source path for renames and copies. */
  origPath: string | null;
  /** Index (staged) status letter, "." when unchanged. Untracked: "?". */
  x: string;
  /** Worktree status letter, "." when unchanged. Untracked: "?". */
  y: string;
  /** The entry is a submodule (porcelain v2 field `S...`). */
  submodule: boolean;
}

export interface ParsedStatus {
  branch: BranchStatus;
  entries: StatusEntry[];
}

/** One row shown in a section of the Source Control view. */
export interface Change {
  path: string;
  origPath: string | null;
  /** Badge letter: M A D R C T, "U" for unmerged (conflict), "?" for untracked. */
  code: string;
  /** Row belongs to the Staged Changes section. */
  staged: boolean;
  untracked: boolean;
  conflict: boolean;
  /** Raw two-letter XY, e.g. "UU", "AA", "DU" (conflicts only). */
  conflictXY: string | null;
  submodule: boolean;
}

export interface GroupedStatus {
  merge: Change[];
  staged: Change[];
  /** Worktree changes plus untracked files (untracked sort last). */
  changes: Change[];
}

/** Splits at most `n` space-separated fields; the remainder (which may hold spaces) is the last item. */
function splitFields(line: string, n: number): string[] {
  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const sp = line.indexOf(" ", pos);
    if (sp === -1) {
      out.push(line.slice(pos));
      return out;
    }
    out.push(line.slice(pos, sp));
    pos = sp + 1;
  }
  out.push(line.slice(pos));
  return out;
}

export function emptyBranch(): BranchStatus {
  return { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
}

/** Parses `git status --porcelain=v2 --branch -z` output. Unknown records are skipped. */
export function parseStatus(raw: string): ParsedStatus {
  const branch = emptyBranch();
  const entries: StatusEntry[] = [];
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec === "") continue;
    const tag = rec[0];
    if (tag === "#") {
      if (rec.startsWith("# branch.oid ")) {
        const v = rec.slice("# branch.oid ".length).trim();
        branch.oid = v === "(initial)" ? null : v;
      } else if (rec.startsWith("# branch.head ")) {
        const v = rec.slice("# branch.head ".length).trim();
        branch.head = v === "(detached)" ? null : v;
      } else if (rec.startsWith("# branch.upstream ")) {
        branch.upstream = rec.slice("# branch.upstream ".length).trim() || null;
      } else if (rec.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(rec);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
    } else if (tag === "1") {
      // 1 XY sub mH mI mW hH hI path
      const f = splitFields(rec, 8);
      if (f.length < 9) continue;
      entries.push({
        kind: "ordinary",
        path: f[8],
        origPath: null,
        x: f[1][0] ?? ".",
        y: f[1][1] ?? ".",
        submodule: f[2].startsWith("S"),
      });
    } else if (tag === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = splitFields(rec, 9);
      if (f.length < 10) continue;
      const orig = parts[++i] ?? null;
      const score = f[8];
      entries.push({
        kind: score.startsWith("C") ? "copy" : "rename",
        path: f[9],
        origPath: orig,
        x: f[1][0] ?? ".",
        y: f[1][1] ?? ".",
        submodule: f[2].startsWith("S"),
      });
    } else if (tag === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = splitFields(rec, 10);
      if (f.length < 11) continue;
      entries.push({
        kind: "unmerged",
        path: f[10],
        origPath: null,
        x: f[1][0] ?? "U",
        y: f[1][1] ?? "U",
        submodule: f[2].startsWith("S"),
      });
    } else if (tag === "?" || tag === "!") {
      entries.push({
        kind: tag === "?" ? "untracked" : "ignored",
        path: rec.slice(2),
        origPath: null,
        x: tag,
        y: tag,
        submodule: false,
      });
    }
  }
  return { branch, entries };
}

function change(e: StatusEntry, code: string, staged: boolean): Change {
  return {
    path: e.path,
    origPath: e.origPath,
    code,
    staged,
    untracked: e.kind === "untracked",
    conflict: e.kind === "unmerged",
    conflictXY: e.kind === "unmerged" ? e.x + e.y : null,
    submodule: e.submodule,
  };
}

const byPath = (a: Change, b: Change): number => a.path.localeCompare(b.path);

/** Sections like VS Code: Merge Changes, Staged Changes, Changes (ignored files are dropped). */
export function groupStatus(entries: StatusEntry[]): GroupedStatus {
  const merge: Change[] = [];
  const staged: Change[] = [];
  const changes: Change[] = [];
  const untracked: Change[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case "ignored":
        break;
      case "unmerged":
        merge.push(change(e, "U", false));
        break;
      case "untracked":
        untracked.push(change(e, "?", false));
        break;
      default:
        if (e.x !== ".") staged.push(change(e, e.x, true));
        if (e.y !== ".") changes.push(change(e, e.y, false));
    }
  }
  merge.sort(byPath);
  staged.sort(byPath);
  changes.sort(byPath);
  untracked.sort(byPath);
  return { merge, staged, changes: [...changes, ...untracked] };
}

export function badgeTitle(c: Change): string {
  if (c.conflict) return `Conflict (${c.conflictXY ?? "UU"})`;
  switch (c.code) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "T":
      return "Type changed";
    case "?":
      return "Untracked";
    default:
      return c.code;
  }
}

// --- tree view ---------------------------------------------------------------

export interface ChangeTreeNode {
  /** Display name of this node (a folder name or a file name). */
  name: string;
  /** Full path of the folder or file, relative to the repo root. */
  path: string;
  /** Present for file leaves. */
  change: Change | null;
  children: ChangeTreeNode[];
}

/** Builds a folder tree of changes. Single-child folder chains are compacted ("a/b/c") like VS Code. */
export function buildChangeTree(changes: Change[]): ChangeTreeNode[] {
  const root: ChangeTreeNode = { name: "", path: "", change: null, children: [] };
  for (const c of changes) {
    const segs = c.path.split("/").filter((s) => s !== "");
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const p = segs.slice(0, i + 1).join("/");
      let next = node.children.find((n) => n.change === null && n.path === p);
      if (!next) {
        next = { name: segs[i], path: p, change: null, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    node.children.push({ name: segs[segs.length - 1] ?? c.path, path: c.path, change: c, children: [] });
  }
  const finish = (nodes: ChangeTreeNode[]): ChangeTreeNode[] => {
    for (const n of nodes) {
      n.children = finish(n.children);
      while (n.change === null && n.children.length === 1 && n.children[0].change === null) {
        const only = n.children[0];
        n.name = `${n.name}/${only.name}`;
        n.path = only.path;
        n.children = only.children;
      }
    }
    return nodes.sort((a, b) => {
      const ad = a.change === null ? 0 : 1;
      const bd = b.change === null ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name);
    });
  };
  return finish(root.children);
}

/** All file changes below a tree node (for "stage folder"). */
export function treeFiles(node: ChangeTreeNode): Change[] {
  if (node.change) return [node.change];
  return node.children.flatMap(treeFiles);
}
