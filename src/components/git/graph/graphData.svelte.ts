// Loads the commit list, ref list and dirty state for the graph (docs/GUIDE.md §14.4.G2).

import { settings } from "../../../lib/settings.svelte";
import { gitStore, GitError } from "../../../lib/git/git.svelte";
import {
  buildLogArgs,
  isEmptyRepoError,
  parseLog,
  parseRefList,
  REF_LIST_ARGS,
  type GitCommit,
  type RefEntry,
} from "../../../lib/git/log";
import { parsePorcelainZ, workingChanges, type WorkingChange } from "../../../lib/git/diff";

async function tolerant(args: string[], ok?: (e: GitError) => boolean): Promise<string> {
  try {
    return await gitStore.run(args);
  } catch (err) {
    if (err instanceof GitError && (!ok || ok(err))) return "";
    throw err;
  }
}

/** `refFilter` value for "all branches" regardless of settings. */
export const ALL_REFS = "*all";

export class GraphData {
  commits = $state.raw<GitCommit[]>([]);
  refs = $state.raw<RefEntry[]>([]);
  /** Staged and unstaged working-tree changes (one row per side). */
  dirty = $state.raw<WorkingChange[]>([]);
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);
  hasMore = $state(false);
  /** Branch filter: null = settings default, `ALL_REFS`, `"HEAD"`, or a full ref name. */
  refFilter = $state<string | null>(null);
  /** Extra pages loaded with "Load more". */
  private pages = 1;
  private token = 0;
  private lastKey = "";

  get max(): number {
    return Math.max(1, settings.git.graphMaxCommits) * this.pages;
  }

  /** SHA of the commit HEAD points at (from decorations, falling back to the store). */
  get headSha(): string | null {
    return this.commits.find((c) => c.refs.some((r) => r.current))?.sha ?? gitStore.head.sha;
  }

  get localBranches(): Set<string> {
    return new Set(this.refs.filter((r) => r.kind === "branch").map((r) => r.name));
  }

  reset(): void {
    this.token++;
    this.commits = [];
    this.refs = [];
    this.dirty = [];
    this.error = null;
    this.hasMore = false;
    this.loaded = false;
    this.loading = false;
    this.pages = 1;
    this.lastKey = "";
  }

  setRefFilter(ref: string | null): void {
    this.refFilter = ref;
    this.pages = 1;
    void this.reload();
  }

  loadMore(): void {
    this.pages++;
    void this.reload();
  }

  async reload(): Promise<void> {
    const my = ++this.token;
    if (!gitStore.sessionId || !gitStore.repo) {
      this.reset();
      return;
    }
    this.loading = true;
    try {
      const max = this.max;
      const [logOut, refsOut, statusOut] = await Promise.all([
        tolerant(
          buildLogArgs({
            max,
            all: this.refFilter === ALL_REFS ? true : this.refFilter === "HEAD" ? false : settings.git.graphAllBranches,
            showRemotes: settings.git.showRemoteBranches,
            ref: this.refFilter && this.refFilter !== ALL_REFS && this.refFilter !== "HEAD" ? this.refFilter : null,
          }),
          (e) => isEmptyRepoError(e.message),
        ),
        tolerant(REF_LIST_ARGS),
        tolerant(["status", "--porcelain=v1", "-z"]),
      ]);
      if (my !== this.token) return;
      const key = `${max}\u0001${logOut}\u0001${refsOut}`;
      if (key !== this.lastKey) {
        this.lastKey = key;
        const refs = parseRefList(refsOut);
        const remotes = new Set(refs.filter((r) => r.kind === "remote").map((r) => r.name));
        const commits = parseLog(logOut, remotes);
        this.refs = refs;
        this.commits = commits;
        this.hasMore = commits.length >= max;
      }
      this.dirty = workingChanges(parsePorcelainZ(statusOut));
      this.error = null;
      this.loaded = true;
    } catch (err) {
      if (my !== this.token) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.loaded = true;
    } finally {
      if (my === this.token) this.loading = false;
    }
  }
}
