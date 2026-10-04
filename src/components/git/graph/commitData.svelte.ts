// Loads one commit's details and changed-file list (docs/GUIDE.md §14.4.G2).

import { gitStore } from "../../../lib/git/git.svelte";
import { detailArgs, parseDetail, type CommitDetail } from "../../../lib/git/log";
import {
  mergeChanges,
  nameStatusArgs,
  numstatArgs,
  parseNameStatusZ,
  parseNumstatZ,
  totalStats,
  type FileChange,
} from "../../../lib/git/diff";

export class CommitData {
  sha = $state<string | null>(null);
  detail = $state.raw<CommitDetail | null>(null);
  files = $state.raw<FileChange[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  /** Which parent the file list / diffs are computed against (merge commits). */
  parentIndex = $state(0);
  private token = 0;
  private remotes: ReadonlySet<string> = new Set();

  get parent(): string | null {
    return this.detail?.parents[this.parentIndex] ?? null;
  }

  get stats(): { added: number; deleted: number } {
    return totalStats(this.files);
  }

  setRemotes(remotes: ReadonlySet<string>): void {
    this.remotes = remotes;
  }

  clear(): void {
    this.token++;
    this.sha = null;
    this.detail = null;
    this.files = [];
    this.loading = false;
    this.error = null;
    this.parentIndex = 0;
  }

  /** Loads `sha` (resetting the parent choice when it is a different commit). */
  async load(sha: string, parentIndex = 0): Promise<void> {
    const my = ++this.token;
    const sameCommit = this.sha === sha;
    this.sha = sha;
    if (!sameCommit) {
      this.detail = null;
      this.files = [];
    }
    this.parentIndex = parentIndex;
    this.loading = true;
    this.error = null;
    try {
      const detail = sameCommit && this.detail ? this.detail : parseDetail(await gitStore.run(detailArgs(sha)), this.remotes);
      if (my !== this.token) return;
      if (!detail) throw new Error(`Could not read commit ${sha}`);
      this.detail = detail;
      const parent = detail.parents[parentIndex] ?? null;
      const [ns, num] = await Promise.all([
        gitStore.run(nameStatusArgs(detail.sha, parent)),
        gitStore.run(numstatArgs(detail.sha, parent)),
      ]);
      if (my !== this.token) return;
      this.files = mergeChanges(parseNameStatusZ(ns), parseNumstatZ(num));
    } catch (err) {
      if (my !== this.token) return;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (my === this.token) this.loading = false;
    }
  }
}
