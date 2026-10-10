// Source control store (docs/GUIDE.md §14). Owner: agent G1. Agent G2 (GitView)
// reads `sessionId`, `repo`, `revision`, `selection`, `head` and calls `run()`;
// do not rename these. All git runs on the VM through `api.gitRun`.

import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import * as api from "../api";
import type { GitOutput } from "../api";
import { app } from "../stores.svelte";
import { settings } from "../settings.svelte";
import { join } from "../paths";
import { emptyBranch, groupStatus, parseStatus, type Change, type GroupedStatus } from "./status";
import {
  friendlyGitError,
  parseRefs,
  parseStashes,
  REF_FORMAT,
  STASH_FORMAT,
  type RefList,
  type StashEntry,
} from "./branches";

/** A non-zero git exit. `message` is stderr (or stdout) trimmed. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly output: GitOutput,
  ) {
    super(message);
  }
}

/** What the main-area GitView shows. */
export type GitSelection =
  | { kind: "change"; path: string; staged: boolean; untracked?: boolean }
  | { kind: "commit"; sha: string; path?: string }
  | null;

export interface GitHead {
  branch: string | null; // null = detached
  sha: string | null; // null = no commits yet
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** What the Source Control view shows for the active session. */
export type ScmState = "disabled" | "disconnected" | "detecting" | "nogit" | "norepo" | "ready";
type DetectState = "detecting" | "ready" | "norepo" | "nogit";

export type CommitMode = "smart" | "staged" | "all";

/** A multi-step operation waiting in the repo (from the files in the git dir). */
export type GitOperation = "merge" | "rebase" | "am" | "cherry-pick" | "revert";

/** Reads the in-progress operation from the names in the git dir. Pure. */
export function operationFromGitDir(names: Iterable<string>): GitOperation | null {
  const set = new Set(names);
  if (set.has("rebase-merge")) return "rebase";
  if (set.has("rebase-apply")) return set.has("rebase-apply/applying") ? "am" : "rebase";
  if (set.has("MERGE_HEAD")) return "merge";
  if (set.has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (set.has("REVERT_HEAD")) return "revert";
  return null;
}

const EMPTY_GROUPS: GroupedStatus = { merge: [], staged: [], changes: [] };
const EMPTY_REFS: RefList = { local: [], remote: [], tags: [] };
const CHUNK = 150;

function chunks<T>(items: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

function errText(e: unknown): string {
  if (e instanceof GitError) return friendlyGitError(e.message);
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

function readView(): "list" | "tree" {
  try {
    return localStorage.getItem("overssh.scm.view") === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

class GitStore {
  /** Repo root (`git rev-parse --show-toplevel`) per session id; null = not a repo. */
  repos = $state<Record<string, string | null>>({});
  head = $state<GitHead>({ branch: null, sha: null, upstream: null, ahead: 0, behind: 0 });
  /** Bumped after every refresh or mutation; GitView reloads its graph when it changes. */
  revision = $state(0);
  selection = $state<GitSelection>(null);

  // --- detection ----------------------------------------------------------------
  /** Set once the Source Control view (or a git command) was used; nothing runs before. */
  activated = $state(false);
  detectStates = $state<Record<string, DetectState>>({});
  /** Why detection failed (shown under "not a repository"), e.g. unsafe ownership. */
  detectMessage = $state("");
  /** Repo folder the user typed in, per session; cleared when the explorer root changes. */
  manualPaths = $state<Record<string, string>>({});

  // --- data for the current session/repo -----------------------------------------
  groups = $state<GroupedStatus>(EMPTY_GROUPS);
  refs = $state<RefList>(EMPTY_REFS);
  remotes = $state<string[]>([]);
  stashes = $state<StashEntry[]>([]);
  /** `.git/MERGE_HEAD` exists: a merge is waiting for conflicts or a commit. */
  merging = $state(false);
  /** Rebase / am / cherry-pick / revert / merge in progress (null = none, or unknown). */
  operation = $state<GitOperation | null>(null);
  /** The git dir could be listed, so `operation` is reliable (else rebase actions are always offered). */
  operationKnown = $state(false);
  /** `${sessionId}|${repo}` the data above was loaded for. */
  loadedKey = $state("");

  // --- UI state --------------------------------------------------------------------
  /** Label of the running mutation ("Pull", "Commit"…), or null. */
  busy = $state<string | null>(null);
  lastError = $state<{ label: string; message: string } | null>(null);
  message = $state("");
  amend = $state(false);
  signOff = $state(false);
  viewMode = $state<"list" | "tree">(readView());
  /** The commit box takes focus when it can, then clears this. */
  focusPending = $state(false);
  /** The branch quick pick is open. */
  pickerOpen = $state(false);

  private dataSid: string | null = null;
  private lastCwd: Record<string, string> = {};
  private chain: Promise<unknown> = Promise.resolve();
  private pendingOps = 0;
  private refreshP: Promise<void> | null = null;
  private refreshAgain = false;
  private needFull = false;
  private disposers: Array<() => void> = [];
  /** Absolute git dir per `${sid}|${repo}` (null = could not be read). */
  private gitDirs: Record<string, string | null> = {};
  /** Latest detect() per session; an older answer is dropped. */
  private detectSeq: Record<string, number> = {};

  get sessionId(): string | null {
    return app.activeSessionId;
  }

  get repo(): string | null {
    const id = this.sessionId;
    return id ? (this.repos[id] ?? null) : null;
  }

  get state(): ScmState {
    if (!settings.git.enabled) return "disabled";
    const id = this.sessionId;
    if (!id || !app.activeWorkspace) return "disconnected";
    const d = this.detectStates[id];
    if (d === "ready" && this.repos[id]) return "ready";
    if (d === "nogit") return "nogit";
    if (d === "norepo") return "norepo";
    return "detecting";
  }

  /** Data on screen belongs to the active session's repo. */
  get loaded(): boolean {
    return this.repo !== null && this.loadedKey === `${this.sessionId}|${this.repo}`;
  }

  /** Folder git looks for a repo in: the typed path, else the explorer root. */
  get startDir(): string {
    const id = this.sessionId;
    if (!id) return "";
    return this.manualPaths[id] ?? app.workspaces[id]?.explorer.cwd ?? "";
  }

  get changeCount(): number {
    return this.groups.merge.length + this.groups.staged.length + this.groups.changes.length;
  }

  // --- running git ---------------------------------------------------------------

  /** Runs git in the current repo. Throws `GitError` on a non-zero exit. */
  async run(args: string[], stdin?: string): Promise<string> {
    const id = this.sessionId;
    const repo = this.repo;
    if (!id || !repo) throw new Error("No repository");
    return this.runIn(id, repo, args, stdin);
  }

  private async runIn(id: string, repo: string, args: string[], stdin?: string): Promise<string> {
    const out = await api.gitRun(id, repo, args, stdin);
    if (out.code !== 0) {
      throw new GitError((out.stderr || out.stdout).trim() || `git ${args[0]} failed`, out);
    }
    return out.stdout;
  }

  // --- lifecycle -----------------------------------------------------------------

  /** Starts detection, auto-fetch and focus refresh. Call once from App; returns a disposer. */
  init(): () => void {
    if (this.disposers.length > 0) return () => {};
    const stopRoot = $effect.root(() => {
      // Detect the repo for the active session whenever the explorer root changes.
      $effect(() => {
        const sid = app.activeSessionId;
        const cwd = app.activeExplorer?.cwd;
        const on = settings.git.enabled && this.activated;
        if (!on || !sid || cwd == null) return;
        untrack(() => {
          if (this.dataSid !== sid) {
            this.resetData();
            this.dataSid = sid;
          }
          const prev = this.lastCwd[sid];
          if (prev !== undefined && prev !== cwd && this.manualPaths[sid]) delete this.manualPaths[sid];
          this.lastCwd[sid] = cwd;
          void this.detect();
        });
      });
      // Auto-fetch timer.
      $effect(() => {
        const minutes = settings.git.autoFetchMinutes;
        const ready = this.state === "ready";
        if (!ready || !(minutes > 0)) return;
        const timer = setInterval(
          () => {
            if (this.busy === null && document.visibilityState === "visible") void this.fetch({ silent: true });
          },
          Math.max(1, minutes) * 60_000,
        );
        return () => clearInterval(timer);
      });
    });
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const onFocus = () => {
      if (this.state !== "ready" || document.visibilityState !== "visible") return;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => void this.refresh(), 150);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const dispose = () => {
      stopRoot();
      clearTimeout(focusTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      this.disposers = [];
    };
    this.disposers.push(dispose);
    return dispose;
  }

  /** Turns on detection (idempotent). Returns once the repo state is known. */
  async ensure(): Promise<boolean> {
    this.activated = true;
    if (!this.sessionId || !app.activeWorkspace) {
      toast.error("Source Control needs a connected session.");
      return false;
    }
    if (!settings.git.enabled) {
      toast.error("Source Control is turned off in Settings.");
      return false;
    }
    if (this.state !== "ready") await this.detect();
    if (this.state === "ready" && !this.loaded) await this.refresh(true);
    if (this.state === "nogit") toast.error("git is not installed on this VM.");
    else if (this.state !== "ready") toast.error("No git repository here. Open Source Control to initialize one.");
    return this.state === "ready";
  }

  private resetData(): void {
    this.groups = EMPTY_GROUPS;
    this.refs = EMPTY_REFS;
    this.remotes = [];
    this.stashes = [];
    this.merging = false;
    this.operation = null;
    this.operationKnown = false;
    this.loadedKey = "";
    this.head = { branch: null, sha: null, upstream: null, ahead: 0, behind: 0 };
    this.selection = null;
    this.message = "";
    this.amend = false;
    this.lastError = null;
    this.revision++;
  }

  // --- detection -------------------------------------------------------------------

  /** Finds the repo for the active session from the typed folder or the explorer root. */
  async detect(path?: string): Promise<void> {
    const sid = this.sessionId;
    if (!sid || !app.workspaces[sid]) return;
    if (path !== undefined) {
      const p = path.trim();
      if (p) this.manualPaths[sid] = p;
      else delete this.manualPaths[sid];
    }
    const start = this.startDir;
    const seq = (this.detectSeq[sid] = (this.detectSeq[sid] ?? 0) + 1);
    if (this.detectStates[sid] !== "ready") this.detectStates[sid] = "detecting";
    let out: GitOutput;
    try {
      out = await api.gitRun(sid, start, ["rev-parse", "--show-toplevel"]);
    } catch (e) {
      out = { code: -1, stdout: "", stderr: errText(e), truncated: false };
    }
    // Session gone, or a newer detection (explorer root changed again) started meanwhile.
    if (!app.workspaces[sid] || this.detectSeq[sid] !== seq) return;
    const top = out.stdout.trim();
    if (out.code === 0 && top) {
      const changed = this.repos[sid] !== top;
      this.repos[sid] = top;
      this.detectStates[sid] = "ready";
      this.detectMessage = "";
      if (sid === this.sessionId) {
        if (changed) this.resetData();
        void this.refresh(true);
      }
      return;
    }
    this.repos[sid] = null;
    const err = out.stderr.trim();
    const noGit = out.code === 127 || /env: .?git.?: No such file|git: (command )?not found/i.test(err);
    this.detectStates[sid] = noGit ? "nogit" : "norepo";
    this.detectMessage = /dubious ownership/i.test(err) ? friendlyGitError(err) : "";
    if (sid === this.sessionId) this.resetData();
  }

  /** "Initialize Repository": `git init -b <defaultBranchName>` in the start folder. */
  async initRepo(): Promise<void> {
    const sid = this.sessionId;
    const dir = this.startDir;
    if (!sid || !dir) return;
    const name = settings.git.defaultBranchName.trim() || "main";
    this.busy = "Initialize";
    try {
      let out = await api.gitRun(sid, dir, ["init", "-b", name]);
      if (out.code !== 0 && /unknown switch|usage:/i.test(out.stderr)) {
        out = await api.gitRun(sid, dir, ["init"]);
        if (out.code === 0) await api.gitRun(sid, dir, ["symbolic-ref", "HEAD", `refs/heads/${name}`]);
      }
      if (out.code !== 0) throw new GitError(out.stderr.trim() || "git init failed", out);
      toast.success("Initialized empty Git repository");
      this.detectStates[sid] = "detecting";
      await this.detect();
    } catch (e) {
      this.fail("Initialize", e);
    } finally {
      this.busy = null;
    }
  }

  // --- refresh ---------------------------------------------------------------------

  /** Reloads status (and, when `full`, branches, tags, stashes and remotes). Calls coalesce. */
  refresh(full = false): Promise<void> {
    if (full) this.needFull = true;
    if (this.refreshP) {
      this.refreshAgain = true;
      return this.refreshP;
    }
    this.refreshP = (async () => {
      do {
        this.refreshAgain = false;
        const f = this.needFull;
        this.needFull = false;
        await this.doRefresh(f);
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshP = null;
    });
    return this.refreshP;
  }

  private async doRefresh(full: boolean): Promise<void> {
    const sid = this.sessionId;
    const repo = this.repo;
    if (!sid || !repo) return;
    const key = `${sid}|${repo}`;
    const fullNow = full || this.loadedKey !== key;
    try {
      if (fullNow || !(key in this.gitDirs)) {
        const gd = await api.gitRun(sid, repo, ["rev-parse", "--absolute-git-dir"]).catch(() => null);
        const dir = gd && gd.code === 0 ? gd.stdout.trim() : "";
        this.gitDirs[key] = dir.startsWith("/") ? dir : null;
      }
      const gitDir = this.gitDirs[key];
      const [status, merge, refs, stash, remotes, gitDirList] = await Promise.all([
        api.gitRun(sid, repo, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
        api.gitRun(sid, repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
        fullNow
          ? api.gitRun(sid, repo, ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"])
          : null,
        fullNow ? api.gitRun(sid, repo, ["stash", "list", `--format=${STASH_FORMAT}`]) : null,
        fullNow ? api.gitRun(sid, repo, ["remote"]) : null,
        gitDir ? api.listDir(sid, gitDir).catch(() => null) : null,
      ]);
      if (sid !== this.sessionId || repo !== this.repo) return; // switched away meanwhile
      if (status.code !== 0) {
        // The folder may have been deleted or is no longer a repository.
        if (/not a git repository|cannot change to/i.test(status.stderr)) void this.detect();
        else this.lastError = { label: "Status", message: friendlyGitError(status.stderr) };
        return;
      }
      const parsed = parseStatus(status.stdout);
      if (status.truncated) {
        this.lastError = {
          label: "Status",
          message: "git status printed more than the output limit; the change list is incomplete. Add large folders to .gitignore.",
        };
      }
      const b = parsed.branch ?? emptyBranch();
      this.groups = groupStatus(parsed.entries);
      this.head = { branch: b.head, sha: b.oid, upstream: b.upstream, ahead: b.ahead, behind: b.behind };
      const names = gitDirList ? gitDirList.map((e) => e.name) : [];
      if (names.includes("rebase-apply")) {
        // `git am` and `git rebase --apply` share rebase-apply; only am writes "applying".
        const sub = await api.listDir(sid, `${gitDir}/rebase-apply`).catch(() => []);
        if (sub.some((e) => e.name === "applying")) names.push("rebase-apply/applying");
      }
      if (sid !== this.sessionId || repo !== this.repo) return;
      this.merging = merge.code === 0 || names.includes("MERGE_HEAD");
      this.operation = gitDirList ? operationFromGitDir(names) : this.merging ? "merge" : null;
      this.operationKnown = gitDirList !== null;
      if (refs && refs.code === 0) this.refs = parseRefs(refs.stdout);
      if (stash) this.stashes = stash.code === 0 ? parseStashes(stash.stdout) : [];
      if (remotes) this.remotes = remotes.code === 0 ? remotes.stdout.split("\n").filter((r) => r.trim() !== "") : [];
      this.loadedKey = key;
      // Drop a selection whose change disappeared (staged, committed, discarded).
      const sel = this.selection;
      if (sel?.kind === "change") {
        const list = sel.staged ? this.groups.staged : [...this.groups.changes, ...this.groups.merge];
        if (!list.some((c) => c.path === sel.path)) {
          const other = sel.staged ? [...this.groups.changes, ...this.groups.merge] : this.groups.staged;
          const moved = other.find((c) => c.path === sel.path);
          this.selection = moved ? { kind: "change", path: moved.path, staged: moved.staged, untracked: moved.untracked } : null;
        }
      }
    } catch (e) {
      this.lastError = { label: "Status", message: errText(e) };
    } finally {
      this.revision++;
    }
  }

  // --- mutation plumbing -----------------------------------------------------------

  /** Queues a mutation (git takes index.lock, so one at a time), then refreshes. */
  private op<T>(
    label: string,
    fn: () => Promise<T>,
    o: { silent?: boolean; success?: string; full?: boolean } = {},
  ): Promise<T | undefined> {
    this.pendingOps++;
    const job = this.chain.then(async (): Promise<T | undefined> => {
      this.busy = label;
      if (!o.silent) this.lastError = null;
      try {
        const r = await fn();
        if (o.success) toast.success(o.success);
        return r;
      } catch (e) {
        if (!o.silent) this.fail(label, e);
        return undefined;
      } finally {
        this.pendingOps--;
        if (this.pendingOps === 0) this.busy = null;
        await this.refresh(o.full ?? true);
      }
    });
    this.chain = job.catch(() => {});
    return job;
  }

  private fail(label: string, e: unknown): void {
    const message = errText(e);
    this.lastError = { label, message };
    if (/CONFLICT|Automatic merge failed|could not apply/i.test(message)) {
      const stepwise = /rebase|cherry|revert|pull/i.test(label) && !/abort/i.test(label);
      toast.warning(`${label}: conflicts`, {
        description: stepwise
          ? "Resolve them under Merge Changes, stage the files, then Continue (or Abort) in the banner."
          : "Resolve them under Merge Changes, then commit.",
      });
    } else {
      toast.error(`${label} failed`, { description: message.length > 400 ? `${message.slice(0, 400)}…` : message });
    }
  }

  dismissError(): void {
    this.lastError = null;
  }

  setViewMode(mode: "list" | "tree"): void {
    this.viewMode = mode;
    try {
      localStorage.setItem("overssh.scm.view", mode);
    } catch {
      /* ignore */
    }
  }

  // --- staging ---------------------------------------------------------------------

  private get unborn(): boolean {
    return this.head.sha === null;
  }

  stage(changes: Change[]): Promise<void | undefined> {
    const paths = [...new Set(changes.map((c) => c.path))];
    if (paths.length === 0) return Promise.resolve(undefined);
    return this.op("Stage", async () => {
      for (const part of chunks(paths)) await this.run(["add", "--", ...part]);
    });
  }

  unstage(changes: Change[]): Promise<void | undefined> {
    const paths = [...new Set(changes.flatMap((c) => (c.origPath ? [c.path, c.origPath] : [c.path])))];
    if (paths.length === 0) return Promise.resolve(undefined);
    return this.op("Unstage", async () => {
      for (const part of chunks(paths)) {
        if (this.unborn) await this.run(["rm", "--cached", "-r", "-q", "--", ...part]);
        else await this.run(["restore", "--staged", "--", ...part]);
      }
    });
  }

  stageAll(): Promise<void | undefined> {
    return this.op("Stage All", async () => {
      await this.run(["add", "-A"]);
    });
  }

  unstageAll(): Promise<void | undefined> {
    return this.op("Unstage All", async () => {
      if (this.unborn) await this.run(["rm", "--cached", "-r", "-q", "--", "."]);
      else await this.run(["restore", "--staged", "--", "."]);
    });
  }

  /** Discards working-tree changes; untracked files are deleted. Asks first per settings. */
  async discard(changes: Change[]): Promise<void> {
    const list = changes.filter((c) => !c.conflict);
    if (list.length === 0) return;
    if (settings.git.confirmDiscard) {
      const untracked = list.filter((c) => c.untracked).length;
      const one = list.length === 1 ? `"${list[0].path}"` : `${list.length} files`;
      const ok = await app.ask({
        title: "Discard Changes",
        message:
          untracked === list.length
            ? `Delete ${one}? This is irreversible.`
            : `Discard changes to ${one}? This is irreversible.${untracked ? ` ${untracked} untracked file(s) will be deleted.` : ""}`,
        confirmLabel: untracked === list.length ? "Delete" : "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    const tracked = list.filter((c) => !c.untracked).map((c) => c.path);
    const loose = list.filter((c) => c.untracked).map((c) => c.path);
    await this.op("Discard", async () => {
      for (const part of chunks(tracked)) await this.run(["restore", "--", ...part]);
      for (const part of chunks(loose)) await this.run(["clean", "-f", "--", ...part]);
    });
  }

  async discardAll(): Promise<void> {
    await this.discard(this.groups.changes);
  }

  // --- selection / opening ----------------------------------------------------------

  select(c: Change): void {
    this.selection = { kind: "change", path: c.path, staged: c.staged, untracked: c.untracked };
  }

  /** Switches to the explorer and opens the file in the editor. */
  openFile(c: Pick<Change, "path">): void {
    const sid = this.sessionId;
    const repo = this.repo;
    if (!sid || !repo) return;
    app.sidebarView = "explorer";
    void app.openFile(sid, join(repo, c.path));
  }

  // --- commit ----------------------------------------------------------------------

  /** Turning Amend on pre-fills the box with the last commit message when it is empty. */
  async setAmend(on: boolean): Promise<void> {
    this.amend = on;
    if (on && this.message.trim() === "" && this.head.sha) {
      try {
        this.message = (await this.run(["log", "-1", "--format=%B"])).trimEnd();
      } catch {
        /* keep empty */
      }
    }
  }

  async commit(mode: CommitMode = "smart"): Promise<void> {
    const msg = this.message.trim();
    const amend = this.amend;
    if (this.groups.merge.length > 0) {
      toast.error("Resolve merge conflicts first", { description: "Stage the conflicted files, then commit." });
      return;
    }
    const mergeMsg = this.merging && msg === "" && !amend; // concluding a merge: git's MERGE_MSG
    if (msg === "" && !amend && !mergeMsg) {
      toast.error("Enter a commit message");
      this.focusPending = true;
      return;
    }
    let stageFirst = mode === "all";
    if (mode === "staged" && this.groups.staged.length === 0 && !amend) {
      toast.error("There are no staged changes to commit");
      return;
    }
    if (mode === "smart" && this.groups.staged.length === 0 && !amend) {
      const pending = this.groups.changes.length > 0 || this.groups.merge.length > 0;
      if (!pending) {
        toast.info("Nothing to commit");
        return;
      }
      if (!settings.git.smartCommit) {
        toast.error("There are no staged changes", { description: "Stage changes first, or use Commit All." });
        return;
      }
      const ok = await app.ask({
        title: "Commit",
        message: "There are no staged changes to commit. Stage all changes and commit them directly?",
        confirmLabel: "Commit All",
      });
      if (!ok) return;
      stageFirst = true;
    }
    const signOff = this.signOff;
    await this.op(
      amend ? "Amend" : "Commit",
      async () => {
        if (stageFirst) await this.run(["add", "-A"]);
        const args = ["commit"];
        if (signOff) args.push("--signoff");
        if (amend) args.push("--amend");
        let stdin: string | undefined;
        if (msg === "" && (amend || mergeMsg)) args.push("--no-edit");
        else {
          args.push("-F", "-");
          stdin = `${msg}\n`;
        }
        await this.run(args, stdin);
        this.message = "";
        this.amend = false;
      },
      { success: amend ? "Commit amended" : "Committed" },
    );
  }

  /** Undo Last Commit: `reset --soft HEAD~1`, the message goes back into the box. */
  async undoLastCommit(): Promise<void> {
    if (!this.head.sha) return;
    await this.op("Undo Commit", async () => {
      const last = (await this.run(["log", "-1", "--format=%B"])).trimEnd();
      let hasParent = true;
      try {
        await this.run(["rev-parse", "--verify", "-q", "HEAD~1"]);
      } catch {
        hasParent = false;
      }
      if (hasParent) await this.run(["reset", "--soft", "HEAD~1"]);
      else await this.run(["update-ref", "-d", "HEAD"]);
      if (this.message.trim() === "") this.message = last;
    });
  }

  // --- sync ------------------------------------------------------------------------

  private pickRemote(): string | null {
    if (this.remotes.includes("origin")) return "origin";
    return this.remotes[0] ?? null;
  }

  async addRemote(): Promise<string | null> {
    const name = (
      await app.ask({ title: "Add Remote", message: "Remote name", input: { value: "origin" }, confirmLabel: "Next" })
    )?.trim();
    if (!name) return null;
    const url = (await app.ask({ title: "Add Remote", message: `URL for "${name}"`, input: {}, confirmLabel: "Add" }))?.trim();
    if (!url) return null;
    const ok = await this.op("Add Remote", async () => {
      await this.run(["remote", "add", name, url]);
      return true;
    });
    return ok ? name : null;
  }

  fetch(o: { silent?: boolean; remote?: string } = {}): Promise<void | undefined> {
    return this.op(
      "Fetch",
      async () => {
        const args = ["fetch"];
        if (settings.git.pruneOnFetch) args.push("--prune");
        if (o.remote) args.push(o.remote);
        else if (this.remotes.length > 1) args.push("--all");
        await this.run(args);
      },
      { silent: o.silent, success: o.silent ? undefined : "Fetched", full: true },
    );
  }

  private async confirmSync(message: string, label: string): Promise<boolean> {
    if (!settings.git.confirmSync) return true;
    return app.ask({ title: label, message, confirmLabel: label });
  }

  private pullArgs(): string[] {
    return settings.git.pullRebase ? ["pull", "--rebase"] : ["pull", "--no-rebase", "--no-edit"];
  }

  async pull(): Promise<void> {
    const up = this.head.upstream;
    if (!up) {
      toast.info("This branch has no upstream", { description: "Publish the branch first." });
      return;
    }
    if (!(await this.confirmSync(`Pull from "${up}"${settings.git.pullRebase ? " (rebase)" : ""}?`, "Pull"))) return;
    await this.op("Pull", async () => void (await this.run(this.pullArgs())), { success: "Pulled" });
  }

  /** Remote to publish to: the existing one, or ask the user to add one. */
  private async remoteForPublish(): Promise<string | null> {
    const r = this.pickRemote();
    if (r) return r;
    toast.info("No remote is configured", { description: "Add one to publish this branch." });
    return this.addRemote();
  }

  async push(o: { force?: boolean } = {}): Promise<void> {
    const branch = this.head.branch;
    if (!branch) {
      toast.error("Cannot push a detached HEAD");
      return;
    }
    const up = this.head.upstream;
    let args: string[];
    if (up) {
      if (
        !(await this.confirmSync(
          o.force ? `Force push (with lease) to "${up}"? This can overwrite remote commits.` : `Push to "${up}"?`,
          o.force ? "Force Push" : "Push",
        ))
      )
        return;
      args = o.force ? ["push", "--force-with-lease"] : ["push"];
    } else {
      const remote = await this.remoteForPublish();
      if (!remote) return;
      if (!(await this.confirmSync(`Publish "${branch}" to "${remote}"?`, "Publish"))) return;
      args = ["push", ...(o.force ? ["--force-with-lease"] : []), "-u", remote, branch];
    }
    await this.op("Push", async () => void (await this.run(args)), { success: up ? "Pushed" : `Published ${branch}` });
  }

  async sync(): Promise<void> {
    const branch = this.head.branch;
    if (!branch) {
      toast.error("Cannot sync a detached HEAD");
      return;
    }
    const up = this.head.upstream;
    if (!up) {
      await this.push();
      return;
    }
    if (!(await this.confirmSync(`This pulls and pushes commits from and to "${up}".`, "Sync"))) return;
    await this.op(
      "Sync",
      async () => {
        await this.run(this.pullArgs());
        const counts = (await this.run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim().split(/\s+/);
        if (Number(counts[0]) > 0) await this.run(["push"]);
      },
      { success: "Synced" },
    );
  }

  // --- stash -----------------------------------------------------------------------

  async stash(o: { includeUntracked?: boolean; message?: string } = {}): Promise<void> {
    if (this.changeCount === 0) {
      toast.info("There are no changes to stash");
      return;
    }
    let msg = o.message;
    if (msg === undefined) {
      const m = await app.ask({
        title: o.includeUntracked ? "Stash (Include Untracked)" : "Stash",
        message: "Stash message (optional)",
        input: {},
        confirmLabel: "Stash",
      });
      if (m === null) return;
      msg = m.trim();
    }
    const args = ["stash", "push"];
    if (o.includeUntracked) args.push("--include-untracked");
    if (msg) args.push("-m", msg);
    await this.op("Stash", async () => void (await this.run(args)), { success: "Changes stashed" });
  }

  stashApply(ref: string): Promise<void | undefined> {
    return this.op("Apply Stash", async () => void (await this.run(["stash", "apply", ref])), { success: "Stash applied" });
  }

  stashPop(ref: string): Promise<void | undefined> {
    return this.op("Pop Stash", async () => void (await this.run(["stash", "pop", ref])), { success: "Stash popped" });
  }

  async stashDrop(ref: string): Promise<void> {
    const ok = await app.ask({
      title: "Drop Stash",
      message: `Drop ${ref}? This is irreversible.`,
      confirmLabel: "Drop",
      danger: true,
    });
    if (!ok) return;
    await this.op("Drop Stash", async () => void (await this.run(["stash", "drop", ref])));
  }

  // --- branches and tags -------------------------------------------------------------

  /** `target` is a local branch, a remote branch ("origin/x", checked out as a tracking branch) or a tag. */
  async checkout(target: string, o: { remote?: boolean; detach?: boolean } = {}): Promise<void> {
    const args = ["checkout"];
    if (o.remote) args.push("--track");
    if (o.detach) args.push("--detach");
    args.push(target);
    await this.op("Checkout", async () => void (await this.run(args)), { success: `Switched to ${target}` });
  }

  async createBranch(o: { from?: string; name?: string; checkout?: boolean } = {}): Promise<void> {
    let name = o.name?.trim();
    if (!name) {
      name =
        (
          await app.ask({
            title: "Create Branch",
            message: o.from ? `New branch from "${o.from}"` : "New branch name",
            input: {},
            confirmLabel: "Create",
          })
        )?.trim() ?? "";
    }
    if (!name) return;
    const checkout = o.checkout ?? true;
    const args = checkout ? ["checkout", "-b", name] : ["branch", name];
    if (o.from) args.push(o.from);
    await this.op("Create Branch", async () => void (await this.run(args)), { success: `Created ${name}` });
  }

  async renameBranch(old: string): Promise<void> {
    const name = (
      await app.ask({ title: "Rename Branch", message: `Rename "${old}" to`, input: { value: old }, confirmLabel: "Rename" })
    )?.trim();
    if (!name || name === old) return;
    await this.op("Rename Branch", async () => void (await this.run(["branch", "-m", old, name])));
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    const ok = await app.ask({
      title: force ? "Force Delete Branch" : "Delete Branch",
      message: force
        ? `Delete "${name}" even if it has unmerged commits?`
        : `Delete branch "${name}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await this.op("Delete Branch", async () => void (await this.run(["branch", force ? "-D" : "-d", name])), {
      success: `Deleted ${name}`,
    });
  }

  async deleteRemoteBranch(remote: string, short: string): Promise<void> {
    const ok = await app.ask({
      title: "Delete Remote Branch",
      message: `Delete "${short}" from "${remote}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await this.op("Delete Remote Branch", async () => void (await this.run(["push", remote, "--delete", short])));
  }

  async mergeInto(name: string): Promise<void> {
    await this.op("Merge", async () => void (await this.run(["merge", "--no-edit", name])), {
      success: `Merged ${name}`,
    });
  }

  async rebaseOnto(name: string): Promise<void> {
    await this.op("Rebase", async () => void (await this.run(["rebase", name])), { success: `Rebased onto ${name}` });
  }

  rebaseControl(action: "--abort" | "--continue" | "--skip"): Promise<void | undefined> {
    return this.op(
      "Rebase",
      async () => void (await this.run(["-c", "core.editor=true", "rebase", action])),
    );
  }

  /** Continue / skip / abort for cherry-pick, revert and am (no editor opens: core.editor=true). */
  sequenceControl(op: "cherry-pick" | "revert" | "am", action: "--abort" | "--continue" | "--skip"): Promise<void | undefined> {
    const name = op === "am" ? "Apply Patches" : op === "revert" ? "Revert" : "Cherry-pick";
    return this.op(name, async () => void (await this.run(["-c", "core.editor=true", op, action])));
  }

  abortMerge(): Promise<void | undefined> {
    return this.op("Abort Merge", async () => void (await this.run(["merge", "--abort"])));
  }

  async publishBranch(name: string): Promise<void> {
    const remote = await this.remoteForPublish();
    if (!remote) return;
    await this.op("Publish", async () => void (await this.run(["push", "-u", remote, name])), {
      success: `Published ${name}`,
    });
  }

  async setUpstream(branch: string, upstream?: string): Promise<void> {
    let up = upstream;
    if (!up) {
      up =
        (
          await app.ask({
            title: "Set Upstream",
            message: `Upstream for "${branch}" (e.g. origin/${branch})`,
            input: { value: this.pickRemote() ? `${this.pickRemote()}/${branch}` : "" },
            confirmLabel: "Set",
          })
        )?.trim() ?? "";
    }
    if (!up) return;
    await this.op("Set Upstream", async () => void (await this.run(["branch", `--set-upstream-to=${up}`, branch])));
  }

  async createTag(at?: string): Promise<void> {
    const name = (
      await app.ask({ title: "Create Tag", message: at ? `Tag name for ${at}` : "Tag name", input: {}, confirmLabel: "Next" })
    )?.trim();
    if (!name) return;
    const msg = await app.ask({
      title: "Create Tag",
      message: "Message (leave empty for a lightweight tag)",
      input: {},
      confirmLabel: "Create",
    });
    if (msg === null) return;
    const args = ["tag"];
    if (msg.trim()) args.push("-a", name, "-m", msg.trim());
    else args.push(name);
    if (at) args.push(at);
    await this.op("Create Tag", async () => void (await this.run(args)), { success: `Created tag ${name}` });
  }

  async deleteTag(name: string): Promise<void> {
    const ok = await app.ask({ title: "Delete Tag", message: `Delete tag "${name}"?`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await this.op("Delete Tag", async () => void (await this.run(["tag", "-d", name])));
  }

  async pushTag(name: string): Promise<void> {
    const remote = this.pickRemote();
    if (!remote) {
      toast.error("No remote is configured");
      return;
    }
    await this.op("Push Tag", async () => void (await this.run(["push", remote, `refs/tags/${name}`])), {
      success: `Pushed ${name}`,
    });
  }
}

export const gitStore = new GitStore();
