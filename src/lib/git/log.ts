// `git log` / `git show` argument builders and parsers (docs/GUIDE.md §14.4.G2). Pure.

export type RefKind = "branch" | "remote" | "tag" | "head";

export interface GitRef {
  kind: RefKind;
  /** Display name: `main`, `origin/main`, `v1.0`, or `HEAD` (detached). */
  name: string;
  /** The branch HEAD points to, or detached HEAD. */
  current?: boolean;
}

export interface GitCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  authorDate: number;
  committerDate: number;
  subject: string;
  refs: GitRef[];
}

export interface CommitDetail {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerName: string;
  committerEmail: string;
  committerDate: number;
  refs: GitRef[];
  /** Full message (subject + body), trailing whitespace trimmed. */
  message: string;
}

const FS = "\x1f";

/** Record fields: sha, parents, author name/email, author date, committer date, subject, decorations. */
export const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s%x1f%D";
export const DETAIL_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B";

export interface LogOptions {
  max: number;
  /** Use `--all` (graphAllBranches). */
  all: boolean;
  /** With `all`: include remote branches (showRemoteBranches). */
  showRemotes: boolean;
  /** Explicit ref to show instead of all/HEAD (branch filter dropdown). */
  ref?: string | null;
}

export function buildLogArgs(o: LogOptions): string[] {
  const args = ["log", "-z", "--topo-order", `--format=${LOG_FORMAT}`, `--max-count=${Math.max(1, Math.floor(o.max))}`];
  if (o.ref) args.push(o.ref);
  else if (o.all) {
    args.push("--exclude=refs/stash");
    if (o.showRemotes) args.push("--all");
    else args.push("--branches", "--tags", "HEAD");
  } else args.push("HEAD");
  args.push("--");
  return args;
}

/** Parses `%D`: `HEAD -> main, origin/main, tag: v1`. `remotes` = known remote-tracking short names. */
export function parseRefs(decoration: string, remotes: ReadonlySet<string> = new Set()): GitRef[] {
  const out: GitRef[] = [];
  for (const raw of decoration.split(", ")) {
    const d = raw.trim();
    if (!d) continue;
    if (d.startsWith("HEAD -> ")) {
      out.push({ kind: "branch", name: d.slice(8), current: true });
    } else if (d === "HEAD") {
      out.push({ kind: "head", name: "HEAD", current: true });
    } else if (d.startsWith("tag: ")) {
      out.push({ kind: "tag", name: d.slice(5) });
    } else if (d.startsWith("refs/")) {
      // refs/stash and other hidden namespaces.
      continue;
    } else if (remotes.has(d)) {
      if (d.endsWith("/HEAD")) continue;
      out.push({ kind: "remote", name: d });
    } else if (d.endsWith("/HEAD")) {
      continue;
    } else {
      out.push({ kind: "branch", name: d });
    }
  }
  return out;
}

/** Orders badges: current branch / HEAD first, then local, remote, tags. */
export function sortRefs(refs: GitRef[]): GitRef[] {
  const rank = (r: GitRef) => (r.current ? 0 : r.kind === "branch" ? 1 : r.kind === "remote" ? 2 : 3);
  return [...refs].sort((a, b) => rank(a) - rank(b));
}

export function parseLog(stdout: string, remotes: ReadonlySet<string> = new Set()): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const rec of stdout.split("\0")) {
    const r = rec.replace(/^\n+/, "");
    if (!r) continue;
    const f = r.split(FS);
    if (f.length < 8 || f[0].length < 7) continue;
    commits.push({
      sha: f[0],
      parents: f[1] ? f[1].split(" ") : [],
      authorName: f[2],
      authorEmail: f[3],
      authorDate: Number(f[4]) || 0,
      committerDate: Number(f[5]) || 0,
      subject: f[6],
      refs: sortRefs(parseRefs(f[7], remotes)),
    });
  }
  return commits;
}

export function parseDetail(stdout: string, remotes: ReadonlySet<string> = new Set()): CommitDetail | null {
  const f = stdout.replace(/^\n+/, "").split(FS);
  if (f.length < 10) return null;
  return {
    sha: f[0],
    parents: f[1] ? f[1].split(" ") : [],
    authorName: f[2],
    authorEmail: f[3],
    authorDate: Number(f[4]) || 0,
    committerName: f[5],
    committerEmail: f[6],
    committerDate: Number(f[7]) || 0,
    refs: sortRefs(parseRefs(f[8], remotes)),
    message: f.slice(9).join(FS).replace(/\s+$/, ""),
  };
}

export const detailArgs = (sha: string): string[] => ["show", "-s", `--format=${DETAIL_FORMAT}`, sha];

export interface RefEntry {
  /** Full ref name, `refs/heads/main`. */
  full: string;
  /** Display name: `main`, `origin/main`, `v1`. */
  name: string;
  kind: "branch" | "remote" | "tag";
}

export const REF_LIST_ARGS = ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"];

export function parseRefList(stdout: string): RefEntry[] {
  const out: RefEntry[] = [];
  for (const line of stdout.split("\n")) {
    const full = line.trim();
    if (full.startsWith("refs/heads/")) out.push({ full, name: full.slice(11), kind: "branch" });
    else if (full.startsWith("refs/remotes/")) {
      const name = full.slice(13);
      if (!name.endsWith("/HEAD")) out.push({ full, name, kind: "remote" });
    } else if (full.startsWith("refs/tags/")) out.push({ full, name: full.slice(10), kind: "tag" });
  }
  return out;
}

/** True for the error `git log` prints in a repo with no commits. */
export function isEmptyRepoError(message: string): boolean {
  return /does not have any commits yet|bad default revision/i.test(message);
}

export function matchesQuery(c: GitCommit, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return (
    c.subject.toLowerCase().includes(s) ||
    c.authorName.toLowerCase().includes(s) ||
    c.authorEmail.toLowerCase().includes(s) ||
    c.sha.startsWith(s) ||
    c.refs.some((r) => r.name.toLowerCase().includes(s))
  );
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** "5 minutes ago", "3 days ago", "2 years ago". */
export function formatRelative(unixSec: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - unixSec));
  if (diff < 45) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [86400 * 7, "week"],
    [86400 * 30, "month"],
    [86400 * 365, "year"],
  ];
  // Pick the largest unit that fits.
  let idx = 0;
  for (let i = 0; i < units.length; i++) if (diff >= units[i][0]) idx = i;
  const [size, name] = units[idx];
  const n = Math.max(1, Math.floor(diff / size));
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}

export function formatAbsolute(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
