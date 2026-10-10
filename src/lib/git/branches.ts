// Pure parsers for branches, tags and stashes (docs/GUIDE.md §14.4.G1).

/** `git for-each-ref` format used by the store; fields are NUL separated, records newline separated. */
export const REF_FORMAT =
  "%(refname)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(subject)";

export interface LocalBranch {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream branch no longer exists on the remote. */
  gone: boolean;
  current: boolean;
  subject: string;
}

export interface RemoteBranch {
  /** "origin/main". */
  name: string;
  remote: string;
  short: string;
  sha: string;
  subject: string;
}

export interface TagRef {
  name: string;
  sha: string;
  subject: string;
}

export interface RefList {
  local: LocalBranch[];
  remote: RemoteBranch[];
  tags: TagRef[];
}

export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: track.includes("gone") };
}

export function parseRefs(raw: string): RefList {
  const out: RefList = { local: [], remote: [], tags: [] };
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const [ref, sha = "", upstream = "", track = "", head = "", subject = ""] = line.split("\0");
    if (ref.startsWith("refs/heads/")) {
      const t = parseTrack(track);
      out.local.push({
        name: ref.slice("refs/heads/".length),
        sha,
        upstream: upstream || null,
        ahead: t.ahead,
        behind: t.behind,
        gone: t.gone,
        current: head === "*",
        subject,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (name.endsWith("/HEAD")) continue;
      const slash = name.indexOf("/");
      out.remote.push({
        name,
        remote: slash === -1 ? name : name.slice(0, slash),
        short: slash === -1 ? name : name.slice(slash + 1),
        sha,
        subject,
      });
    } else if (ref.startsWith("refs/tags/")) {
      out.tags.push({ name: ref.slice("refs/tags/".length), sha, subject });
    }
  }
  out.local.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  out.remote.sort((a, b) => a.name.localeCompare(b.name));
  out.tags.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  return out;
}

export interface StashEntry {
  /** "stash@{0}". */
  ref: string;
  index: number;
  message: string;
  when: string;
}

/** `git stash list --format=%gd%x00%s%x00%cr` */
export const STASH_FORMAT = "%gd%x00%s%x00%cr";

export function parseStashes(raw: string): StashEntry[] {
  const out: StashEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const [ref, message = "", when = ""] = line.split("\0");
    const m = /\{(\d+)\}/.exec(ref);
    out.push({ ref, index: m ? Number(m[1]) : out.length, message, when });
  }
  return out;
}

/** Turns git's stderr into a short hint. Never echoes more than the first lines of stderr. */
export function friendlyGitError(stderr: string): string {
  const text = stderr.trim();
  const low = text.toLowerCase();
  if (
    low.includes("could not read username") ||
    low.includes("terminal prompts disabled") ||
    low.includes("authentication failed") ||
    low.includes("permission denied (publickey") ||
    low.includes("could not read password")
  ) {
    return `Authentication failed. OverSSH cannot prompt for credentials: use an SSH remote with an agent or key, or configure a credential helper on the VM.\n${firstLines(text, 3)}`;
  }
  if (low.includes("host key verification failed")) {
    return `Host key verification failed on the VM. Run "ssh <remote-host>" once in a terminal to trust it.\n${firstLines(text, 3)}`;
  }
  if (low.includes("detected dubious ownership")) {
    return `Git refuses this repository (unsafe ownership). Run "git config --global --add safe.directory <repo>" on the VM.\n${firstLines(text, 2)}`;
  }
  if (low.includes("index.lock") && low.includes("file exists")) {
    return `Another git process is running in this repository (index.lock exists). Wait for it, or remove .git/index.lock on the VM if no git is running.
${firstLines(text, 2)}`;
  }
  if (low.includes("could not resolve host") || low.includes("connection timed out") || low.includes("connection refused")) {
    return `The VM cannot reach the remote. Check its network, DNS or proxy settings.
${firstLines(text, 3)}`;
  }
  if (low.includes("please tell me who you are") || low.includes("unable to auto-detect email")) {
    return 'Git user is not set on the VM. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com".';
  }
  return firstLines(text, 8);
}

function firstLines(text: string, n: number): string {
  return text.split("\n").slice(0, n).join("\n");
}
