// Changed-file lists and diff sources for commits and working changes
// (docs/GUIDE.md §14.4.G2). Pure: parsers and argument builders only.

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface FileChange {
  /** Path after the change (repo-relative, POSIX). */
  path: string;
  /** Source path of a rename / copy. */
  oldPath?: string;
  status: ChangeStatus;
  /** Rename / copy similarity percentage. */
  similarity?: number;
  /** null for binary files. */
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

function toStatus(letter: string): ChangeStatus {
  const c = letter[0];
  return c === "A" || c === "M" || c === "D" || c === "R" || c === "C" || c === "T" ? c : "U";
}

interface NameStatus {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  similarity?: number;
}

/** `git diff-tree --name-status -z`: `M\0path\0` and `R100\0old\0new\0`. */
export function parseNameStatusZ(out: string): NameStatus[] {
  const t = out.split("\0");
  const res: NameStatus[] = [];
  for (let i = 0; i < t.length; ) {
    const s = t[i++];
    if (!s) continue;
    const status = toStatus(s);
    if (status === "R" || status === "C") {
      const oldPath = t[i++];
      const path = t[i++];
      if (path === undefined) break;
      res.push({ path, oldPath, status, similarity: Number(s.slice(1)) || undefined });
    } else {
      const path = t[i++];
      if (path === undefined) break;
      res.push({ path, status });
    }
  }
  return res;
}

interface NumStat {
  path: string;
  added: number | null;
  deleted: number | null;
}

/** `git diff-tree --numstat -z`: `1\t2\tpath\0` and `1\t2\t\0old\0new\0`; `-\t-` = binary. */
export function parseNumstatZ(out: string): NumStat[] {
  const t = out.split("\0");
  const res: NumStat[] = [];
  for (let i = 0; i < t.length; ) {
    const s = t[i++];
    if (!s) continue;
    const parts = s.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? null : Number(parts[0]);
    const deleted = parts[1] === "-" ? null : Number(parts[1]);
    let path = parts.slice(2).join("\t");
    if (path === "") {
      i++; // old path
      path = t[i++] ?? "";
    }
    res.push({ path, added, deleted });
  }
  return res;
}

export function mergeChanges(nameStatus: NameStatus[], numstat: NumStat[]): FileChange[] {
  const stats = new Map(numstat.map((n) => [n.path, n]));
  return nameStatus.map((n) => {
    const s = stats.get(n.path);
    return {
      ...n,
      added: s ? s.added : 0,
      deleted: s ? s.deleted : 0,
      binary: s ? s.added === null : false,
    };
  });
}

/** `-M` rename detection, no commit header. `parent` null = root commit. */
function treeArgs(kind: "--name-status" | "--numstat", sha: string, parent: string | null): string[] {
  return ["diff-tree", "-r", "-M", "-z", "--no-commit-id", kind, ...(parent ? [parent, sha] : ["--root", sha])];
}
export const nameStatusArgs = (sha: string, parent: string | null) => treeArgs("--name-status", sha, parent);
export const numstatArgs = (sha: string, parent: string | null) => treeArgs("--numstat", sha, parent);

// --- tree view ---------------------------------------------------------------

export interface TreeRow {
  kind: "dir" | "file";
  /** Display name (a compacted directory chain shows `a/b/c`). */
  name: string;
  /** Full path of the dir or file. */
  path: string;
  depth: number;
  change?: FileChange;
}

interface Node {
  name: string;
  path: string;
  dirs: Map<string, Node>;
  files: FileChange[];
}

export function flattenTree(files: readonly FileChange[], collapsed: ReadonlySet<string> = new Set()): TreeRow[] {
  const root: Node = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = n.dirs.get(parts[i]);
      if (!child) {
        child = { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        n.dirs.set(parts[i], child);
      }
      n = child;
    }
    n.files.push(f);
  }
  const rows: TreeRow[] = [];
  const walk = (n: Node, depth: number): void => {
    const dirs = [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (let d of dirs) {
      let name = d.name;
      // Compact chains of single-child directories.
      while (d.files.length === 0 && d.dirs.size === 1) {
        d = [...d.dirs.values()][0];
        name += "/" + d.name;
      }
      rows.push({ kind: "dir", name, path: d.path, depth });
      if (!collapsed.has(d.path)) walk(d, depth + 1);
    }
    for (const f of [...n.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: "file", name: f.path.slice(f.path.lastIndexOf("/") + 1), path: f.path, depth, change: f });
    }
  };
  walk(root, 0);
  return rows;
}

export function totalStats(files: readonly FileChange[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const f of files) {
    added += f.added ?? 0;
    deleted += f.deleted ?? 0;
  }
  return { added, deleted };
}

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Unmerged",
};

// --- diff sources -------------------------------------------------------------

/** Where one side of a diff comes from. */
export type DiffSide =
  | { kind: "empty" }
  /** A git object spec for `git cat-file blob`: `abc123:path`, `:path` (index). */
  | { kind: "git"; spec: string }
  /** A file in the working tree (read over SFTP), path relative to the repo root. */
  | { kind: "work"; path: string };

export interface DiffSources {
  path: string;
  oldPath?: string;
  original: DiffSide;
  modified: DiffSide;
  originalLabel: string;
  modifiedLabel: string;
}

/** `parent` null = root commit (everything is added). */
export function commitDiffSources(sha: string, parent: string | null, c: FileChange): DiffSources {
  const old = c.oldPath ?? c.path;
  const s = (r: string) => r.slice(0, 7);
  return {
    path: c.path,
    oldPath: c.oldPath,
    original: parent && c.status !== "A" ? { kind: "git", spec: `${parent}:${old}` } : { kind: "empty" },
    modified: c.status === "D" ? { kind: "empty" } : { kind: "git", spec: `${sha}:${c.path}` },
    originalLabel: parent ? `${s(parent)}:${old}` : "(empty)",
    modifiedLabel: `${s(sha)}:${c.path}`,
  };
}

/** Working-change diff. staged = HEAD vs index; unstaged = index vs working file; untracked = empty vs file. */
export function changeDiffSources(o: { path: string; staged: boolean; untracked?: boolean; oldPath?: string }): DiffSources {
  const { path } = o;
  if (o.staged) {
    return {
      path,
      oldPath: o.oldPath,
      original: { kind: "git", spec: `HEAD:${o.oldPath ?? path}` },
      modified: { kind: "git", spec: `:${path}` },
      originalLabel: "HEAD",
      modifiedLabel: "Index",
    };
  }
  return {
    path,
    original: o.untracked ? { kind: "empty" } : { kind: "git", spec: `:${path}` },
    modified: { kind: "work", path },
    originalLabel: o.untracked ? "(empty)" : "Index",
    modifiedLabel: "Working tree",
  };
}

export const catBlobArgs = (spec: string): string[] => ["cat-file", "blob", spec];

/** `git cat-file` on a path that is not in that tree / the index. */
export function isMissingPathError(message: string): boolean {
  return /does not exist|exists on disk, but not in|not in the index|Not a valid object name|invalid object name|unknown revision|bad revision/i.test(
    message,
  );
}

export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\0");
}

// --- working tree status (uncommitted row) -----------------------------------------

export interface StatusEntry {
  x: string;
  y: string;
  path: string;
  oldPath?: string;
}

/** `git status --porcelain=v1 -z`: `XY path\0` and `XY new\0old\0` for renames/copies. */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const t = out.split("\0");
  const res: StatusEntry[] = [];
  for (let i = 0; i < t.length; ) {
    const s = t[i++];
    if (s.length < 4) continue;
    const x = s[0];
    const y = s[1];
    const path = s.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") res.push({ x, y, path, oldPath: t[i++] });
    else res.push({ x, y, path });
  }
  return res;
}

export interface WorkingChange {
  path: string;
  oldPath?: string;
  staged: boolean;
  untracked: boolean;
  /** Display letter: A M D R U ? */
  letter: string;
}

/** Splits porcelain entries into staged and unstaged rows (a file can appear in both). */
export function workingChanges(entries: readonly StatusEntry[]): WorkingChange[] {
  const res: WorkingChange[] = [];
  for (const e of entries) {
    if (e.x === "?" && e.y === "?") {
      res.push({ path: e.path, staged: false, untracked: true, letter: "U" });
      continue;
    }
    if (e.x === "!" ) continue;
    if (e.x !== " ") res.push({ path: e.path, oldPath: e.oldPath, staged: true, untracked: false, letter: e.x });
    if (e.y !== " ") res.push({ path: e.path, staged: false, untracked: false, letter: e.y });
  }
  return res;
}
