// Fake git for the UI harness, agent G1 (docs/GUIDE.md §14.4.G1): answers the
// `git_run` calls the Source Control sidebar makes (status, staging, commit,
// branches, stash, sync). Dispatched from mockBackend.ts; returns null for
// arguments it does not know so another handler (agent G2) can answer.

export interface FakeGitOutput {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface FakeFile {
  path: string;
  x: string;
  y: string;
  orig?: string;
  unmerged?: boolean;
}

interface FakeRepo {
  root: string;
  branch: string;
  sha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FakeFile[];
  branches: string[];
  upstreams: Record<string, string>;
  remoteBranches: string[];
  tags: string[];
  stashes: { msg: string; files: FakeFile[] }[];
  remotes: string[];
  commits: { msg: string; args: string[] }[];
  merging: boolean;
  /** Names in the git dir (HF2: rebase/cherry-pick detection). Unset = the git dir cannot be read. */
  gitDirEntries?: string[];
}

export const SEED_REPO = "/home/testuser/projects";

function seedRepo(): FakeRepo {
  return {
    root: SEED_REPO,
    branch: "main",
    sha: "abc1234abc1234abc1234abc1234abc1234abc12",
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    files: [
      { path: "README.md", x: "M", y: "." },
      { path: "docs/guide.md", x: "R", y: ".", orig: "docs/old.md" },
      { path: "src/app.js", x: ".", y: "M" },
      { path: "src/gone.js", x: ".", y: "D" },
      { path: "notes.txt", x: "?", y: "?" },
    ],
    branches: ["main", "dev"],
    upstreams: { main: "origin/main" },
    remoteBranches: ["origin/main", "origin/feature/x"],
    tags: ["v1.0"],
    stashes: [],
    remotes: ["origin"],
    commits: [],
    merging: false,
  };
}

const repos = new Map<string, FakeRepo>([[SEED_REPO, seedRepo()]]);
let missing = false;

export const gitCalls: { repo: string; args: string[]; stdin?: string }[] = [];

export function setGitMissing(v: boolean): void {
  missing = v;
}

function ok(stdout = ""): FakeGitOutput {
  return { code: 0, stdout, stderr: "", truncated: false };
}
function fail(code: number, stderr: string, stdout = ""): FakeGitOutput {
  return { code, stdout, stderr, truncated: false };
}

function repoFor(dir: string): FakeRepo | null {
  let best: FakeRepo | null = null;
  for (const r of repos.values()) {
    if ((dir === r.root || dir.startsWith(`${r.root}/`)) && (!best || r.root.length > best.root.length)) best = r;
  }
  return best;
}

const HASH = "1".repeat(40);

function statusOut(r: FakeRepo): string {
  const out: string[] = [];
  out.push(`# branch.oid ${r.sha ?? "(initial)"}`);
  out.push(`# branch.head ${r.branch}`);
  if (r.upstream) {
    out.push(`# branch.upstream ${r.upstream}`);
    out.push(`# branch.ab +${r.ahead} -${r.behind}`);
  }
  for (const f of r.files) {
    if (f.unmerged) out.push(`u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} ${f.path}`);
    else if (f.x === "?") out.push(`? ${f.path}`);
    else if (f.orig) out.push(`2 ${f.x}${f.y} N... 100644 100644 100644 ${HASH} ${HASH} R100 ${f.path}`, f.orig);
    else out.push(`1 ${f.x}${f.y} N... 100644 100644 100644 ${HASH} ${HASH} ${f.path}`);
  }
  return `${out.join("\0")}\0`;
}

function refsOut(r: FakeRepo): string {
  const lines: string[] = [];
  for (const b of r.branches) {
    const up = r.upstreams[b] ?? "";
    const track = b === r.branch && up ? (r.ahead || r.behind ? `${r.ahead ? `ahead ${r.ahead}` : ""}${r.ahead && r.behind ? ", " : ""}${r.behind ? `behind ${r.behind}` : ""}` : "") : "";
    lines.push(["refs/heads/" + b, "abc1234", up, track, b === r.branch ? "*" : " ", `subject of ${b}`].join("\0"));
  }
  for (const b of r.remoteBranches) lines.push([`refs/remotes/${b}`, "abc1234", "", "", " ", "remote subject"].join("\0"));
  for (const t of r.tags) lines.push([`refs/tags/${t}`, "abc1234", "", "", " ", "release"].join("\0"));
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function paths(args: string[]): string[] {
  const i = args.indexOf("--");
  return i === -1 ? [] : args.slice(i + 1);
}

function matches(f: FakeFile, ps: string[]): boolean {
  return ps.includes(".") || ps.includes(f.path) || (f.orig !== undefined && ps.includes(f.orig));
}

function stageFile(f: FakeFile): void {
  if (f.x === "?") {
    f.x = "A";
    f.y = ".";
  } else if (f.y !== ".") {
    f.x = f.x === "." ? f.y : f.x;
    f.y = ".";
  }
  if (f.unmerged) {
    f.unmerged = false;
    f.x = "M";
    f.y = ".";
  }
}

function unstageFile(f: FakeFile): void {
  if (f.x === "A") {
    f.x = "?";
    f.y = "?";
  } else if (f.x !== ".") {
    f.y = f.y === "." ? f.x : f.y;
    f.x = ".";
    f.orig = undefined;
  }
}

function nextSha(r: FakeRepo): string {
  return String(r.commits.length + 1).padStart(7, "0").repeat(6).slice(0, 40);
}

export function g1GitRun(dir: string, rawArgs: string[], stdin?: string): FakeGitOutput | null {
  gitCalls.push({ repo: dir, args: [...rawArgs], stdin });
  if (missing) return fail(127, "env: 'git': No such file or directory");
  // Skip leading `-c key=value` pairs.
  const args = [...rawArgs];
  while (args[0] === "-c") args.splice(0, 2);
  const cmd = args[0];

  if (cmd === "init") {
    const name = args[1] === "-b" ? args[2] : "master";
    repos.set(dir, {
      root: dir,
      branch: name,
      sha: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [
        { path: "notes.md", x: "?", y: "?" },
        { path: "readme.txt", x: "?", y: "?" },
      ],
      branches: [],
      upstreams: {},
      remoteBranches: [],
      tags: [],
      stashes: [],
      remotes: [],
      commits: [],
      merging: false,
    });
    return ok(`Initialized empty Git repository in ${dir}/.git/\n`);
  }

  const r = repoFor(dir);
  if (cmd === "rev-parse" && args.includes("--show-toplevel")) {
    return r ? ok(`${r.root}\n`) : fail(128, "fatal: not a git repository (or any of the parent directories): .git");
  }
  if (!r) {
    return ["status", "for-each-ref", "stash", "remote", "add", "commit", "rev-parse"].includes(cmd)
      ? fail(128, "fatal: not a git repository (or any of the parent directories): .git")
      : null;
  }

  switch (cmd) {
    case "status":
      return ok(statusOut(r));
    case "for-each-ref":
      return ok(refsOut(r));
    case "remote":
      return ok(r.remotes.map((x) => `${x}\n`).join(""));
    case "rev-parse":
      if (args.includes("--absolute-git-dir")) return r.gitDirEntries ? ok(`${r.root}/.git
`) : null;
      if (args.includes("MERGE_HEAD")) return r.merging ? ok(`${HASH}\n`) : fail(1, "");
      if (args.includes("HEAD~1")) return r.commits.length > 0 || r.sha ? ok(`${HASH}\n`) : fail(1, "");
      return null;
    case "add": {
      const ps = args.includes("-A") ? ["."] : paths(args);
      for (const f of r.files) if (matches(f, ps)) stageFile(f);
      return ok();
    }
    case "restore": {
      const ps = paths(args);
      if (args.includes("--staged")) {
        for (const f of r.files) if (matches(f, ps)) unstageFile(f);
      } else {
        for (const f of [...r.files]) {
          if (!matches(f, ps)) continue;
          f.y = ".";
          if (f.x === ".") r.files.splice(r.files.indexOf(f), 1);
        }
      }
      return ok();
    }
    case "rm": {
      for (const f of r.files) if (matches(f, paths(args))) unstageFile(f);
      return ok();
    }
    case "clean": {
      const ps = paths(args);
      r.files = r.files.filter((f) => !(f.x === "?" && matches(f, ps)));
      return ok();
    }
    case "commit": {
      const msg = stdin ?? "";
      r.commits.push({ msg, args: [...args] });
      if (!args.includes("--amend")) {
        r.sha = nextSha(r);
        r.ahead += r.upstream ? 1 : 0;
        if (r.branches.length === 0) r.branches.push(r.branch);
      }
      r.files = r.files.filter((f) => f.x === "." || f.x === "?").map((f) => ({ ...f, orig: undefined }));
      r.merging = false;
      return ok(`[${r.branch} ${r.sha?.slice(0, 7)}] ${msg.split("\n")[0]}\n`);
    }
    case "log":
      return ok(`${r.commits.at(-1)?.msg ?? "previous message"}\n`);
    case "reset":
      return ok();
    case "stash": {
      const sub = args[1];
      if (sub === "list") return ok(r.stashes.map((s, i) => `stash@{${i}}\0${s.msg}\0${i + 1} minutes ago\n`).join(""));
      if (sub === "push") {
        const mi = args.indexOf("-m");
        const incl = args.includes("--include-untracked");
        const taken = r.files.filter((f) => incl || f.x !== "?");
        r.files = r.files.filter((f) => !taken.includes(f));
        r.stashes.unshift({ msg: mi === -1 ? `WIP on ${r.branch}` : `On ${r.branch}: ${args[mi + 1]}`, files: taken });
        return ok("Saved working directory and index state\n");
      }
      const idx = Number(/\{(\d+)\}/.exec(args[2] ?? "")?.[1] ?? 0);
      const s = r.stashes[idx];
      if (!s) return fail(1, "error: stash not found");
      if (sub === "apply" || sub === "pop") r.files.push(...s.files);
      if (sub === "pop" || sub === "drop") r.stashes.splice(idx, 1);
      return ok();
    }
    case "checkout": {
      const rest = args.slice(1).filter((a) => !a.startsWith("--"));
      if (args[1] === "-b") {
        const name = args[2];
        r.branches.push(name);
        r.branch = name;
        r.upstream = null;
        r.ahead = r.behind = 0;
        return ok(`Switched to a new branch '${name}'\n`);
      }
      const target = rest[0];
      if (args.includes("--track")) {
        const short = target.slice(target.indexOf("/") + 1);
        if (!r.branches.includes(short)) r.branches.push(short);
        r.upstreams[short] = target;
        r.branch = short;
        r.upstream = target;
        r.ahead = r.behind = 0;
        return ok();
      }
      if (r.tags.includes(target) || args.includes("--detach")) {
        r.branch = "(detached)";
        r.upstream = null;
        return ok();
      }
      r.branch = target;
      r.upstream = r.upstreams[target] ?? null;
      r.ahead = r.behind = 0;
      return ok(`Switched to branch '${target}'\n`);
    }
    case "branch": {
      if (args[1] === "-m") {
        const i = r.branches.indexOf(args[2]);
        if (i !== -1) r.branches[i] = args[3];
        if (r.branch === args[2]) r.branch = args[3];
        return ok();
      }
      if (args[1] === "-d" || args[1] === "-D") {
        r.branches = r.branches.filter((b) => b !== args[2]);
        return ok(`Deleted branch ${args[2]}\n`);
      }
      if (args[1]?.startsWith("--set-upstream-to=")) {
        const up = args[1].slice("--set-upstream-to=".length);
        const b = args[2] ?? r.branch;
        r.upstreams[b] = up;
        if (b === r.branch) r.upstream = up;
        return ok();
      }
      r.branches.push(args[1]);
      return ok();
    }
    case "rebase":
    case "cherry-pick":
    case "revert": {
      const ctl = args.find((a) => a === "--continue" || a === "--abort" || a === "--skip");
      if (!ctl) return null;
      const marker = cmd === "rebase" ? "rebase-merge" : cmd === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD";
      if (!r.gitDirEntries?.includes(marker)) return fail(128, `fatal: no ${cmd} in progress`);
      if (ctl === "--continue" && r.files.some((f) => f.unmerged)) return fail(1, "", "error: you must edit all merge conflicts and then\nmark them as resolved using git add\n");
      r.gitDirEntries = r.gitDirEntries.filter((n) => n !== marker);
      if (ctl === "--abort") r.files = r.files.filter((f) => !f.unmerged);
      return ok();
    }
    case "merge": {
      if (args.includes("conflict-branch")) {
        r.merging = true;
        r.files.push({ path: "clash.txt", x: "U", y: "U", unmerged: true });
        return fail(1, "", "CONFLICT (content): Merge conflict in clash.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n");
      }
      return ok("Merge made by the 'ort' strategy.\n");
    }
    case "tag": {
      if (args[1] === "-d") r.tags = r.tags.filter((t) => t !== args[2]);
      else r.tags.push(args[1] === "-a" ? args[2] : args[1]);
      return ok();
    }
    case "fetch":
      return ok();
    case "pull":
      r.behind = 0;
      return ok("Already up to date.\n");
    case "push": {
      if (args.includes("-u")) {
        const i = args.indexOf("-u");
        const remote = args[i + 1];
        const b = args[i + 2];
        r.upstreams[b] = `${remote}/${b}`;
        if (b === r.branch) r.upstream = `${remote}/${b}`;
        r.remoteBranches.push(`${remote}/${b}`);
      }
      if (args.includes("rejected-remote")) return fail(1, "! [rejected] main -> main (non-fast-forward)");
      r.ahead = 0;
      return ok();
    }
    case "rev-list":
      return ok(`${r.ahead}\t${r.behind}\n`);
    default:
      return null;
  }
}

/** Test-only view of the fake repo state. */
export function g1Snapshot(root = SEED_REPO): Record<string, unknown> | null {
  const r = repos.get(root);
  return r ? JSON.parse(JSON.stringify(r)) : null;
}

/** Test-only: change the fake repo (e.g. make the branch behind its upstream). */
export function g1Patch(root: string, patch: Partial<FakeRepo>): void {
  const r = repos.get(root);
  if (r) Object.assign(r, patch);
}

/** Test-only: `list_dir` of a fake repo's git dir (`<root>/.git`), or null for other paths. */
export function g1GitDirList(path: string): { name: string; path: string; kind: "file" | "dir" }[] | null {
  for (const r of repos.values()) {
    if (r.gitDirEntries && path === `${r.root}/.git`) {
      return r.gitDirEntries.map((name) => ({ name, path: `${path}/${name}`, kind: name.startsWith("rebase-") ? "dir" : "file" }));
    }
  }
  return null;
}
