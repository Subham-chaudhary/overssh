// Mutating git commands used by the graph's context menus (docs/GUIDE.md §14.4.G2).
// Every call bumps `gitStore.revision` afterwards (success or failure: a failed
// cherry-pick / merge can leave the repo mid-operation) so the graph and the
// Source Control sidebar reload.

import { clipboardWrite } from "$lib/clipboard";
import { app } from "../../../lib/stores.svelte";
import { GitError, gitStore } from "../../../lib/git/git.svelte";
import { shortSha, type GitRef } from "../../../lib/git/log";
import { friendlyGitError } from "../../../lib/git/branches";

function message(err: unknown): string {
  if (err instanceof GitError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Runs one git command, toasts failures. Returns true on success. */
export async function mutate(args: string[], success?: string): Promise<boolean> {
  // A sidebar mutation (commit, pull, ...) holds index.lock: running now would fail with a lock error.
  if (gitStore.busy !== null) {
    app.addToast("info", `Wait for "${gitStore.busy}" to finish first.`);
    return false;
  }
  try {
    await gitStore.run(args);
    if (success) app.addToast("success", success);
    return true;
  } catch (err) {
    const text = message(err);
    if (/CONFLICT|could not apply|after resolving the conflicts/i.test(text)) {
      app.addToast("error", `${friendlyGitError(text)}
Resolve the conflicts in Source Control, stage the files, then Continue (or Abort).`);
    } else app.addToast("error", friendlyGitError(text));
    return false;
  } finally {
    // Status too (not only the graph): a conflicted cherry-pick / revert shows its Continue / Abort banner.
    if (gitStore.repo) void gitStore.refresh(true);
    else gitStore.revision++;
  }
}

export async function checkoutDetached(sha: string): Promise<boolean> {
  return mutate(["checkout", "--detach", sha], `Checked out ${shortSha(sha)} (detached HEAD)`);
}

export async function createBranchAt(sha: string): Promise<boolean> {
  const name = (await app.ask({ title: "Create branch", message: `At ${shortSha(sha)}`, input: {}, confirmLabel: "Create" }))?.trim();
  if (!name) return false;
  return mutate(["branch", name, sha], `Created branch ${name}`);
}

export async function createTagAt(sha: string): Promise<boolean> {
  const name = (await app.ask({ title: "Create tag", message: `At ${shortSha(sha)}`, input: {}, confirmLabel: "Create" }))?.trim();
  if (!name) return false;
  return mutate(["tag", name, sha], `Created tag ${name}`);
}

export async function cherryPick(sha: string, isMerge: boolean): Promise<boolean> {
  return mutate(["cherry-pick", ...(isMerge ? ["-m", "1"] : []), sha], `Cherry-picked ${shortSha(sha)}`);
}

export async function revertCommit(sha: string, isMerge: boolean): Promise<boolean> {
  return mutate(["revert", "--no-edit", ...(isMerge ? ["-m", "1"] : []), sha], `Reverted ${shortSha(sha)}`);
}

export type ResetMode = "soft" | "mixed" | "hard";

export async function resetTo(sha: string, mode: ResetMode): Promise<boolean> {
  if (mode === "hard") {
    const ok = await app.ask({
      title: "Hard reset",
      message: `Reset the current branch to ${shortSha(sha)} and discard all uncommitted changes? This cannot be undone.`,
      confirmLabel: "Hard reset",
      danger: true,
    });
    if (!ok) return false;
  }
  return mutate(["reset", `--${mode}`, sha], `Reset (${mode}) to ${shortSha(sha)}`);
}

/** Checks out a branch badge. A remote branch checks out (or creates) the local branch of the same name. */
export async function checkoutRef(ref: GitRef, localBranches: ReadonlySet<string>): Promise<boolean> {
  if (ref.kind === "tag") return mutate(["checkout", "--detach", ref.name], `Checked out tag ${ref.name} (detached HEAD)`);
  if (ref.kind === "remote") {
    const local = ref.name.slice(ref.name.indexOf("/") + 1);
    if (localBranches.has(local)) return mutate(["checkout", local], `Switched to ${local}`);
    return mutate(["checkout", "--track", ref.name], `Switched to ${local}`);
  }
  return mutate(["checkout", ref.name], `Switched to ${ref.name}`);
}

/** Deletes a local branch (retries with -D after a confirm if unmerged) or a tag. */
export async function deleteRef(ref: GitRef): Promise<boolean> {
  if (ref.kind === "tag") {
    const ok = await app.ask({ title: "Delete tag", message: `Delete tag ${ref.name}?`, confirmLabel: "Delete", danger: true });
    return ok ? mutate(["tag", "-d", ref.name], `Deleted tag ${ref.name}`) : false;
  }
  if (ref.kind !== "branch" || ref.current) return false;
  const ok = await app.ask({ title: "Delete branch", message: `Delete branch ${ref.name}?`, confirmLabel: "Delete", danger: true });
  if (!ok) return false;
  try {
    await gitStore.run(["branch", "-d", ref.name]);
    app.addToast("success", `Deleted branch ${ref.name}`);
    return true;
  } catch (err) {
    if (/not fully merged/i.test(message(err))) {
      const force = await app.ask({
        title: "Branch not fully merged",
        message: `${ref.name} has commits that are not merged anywhere else. Delete it anyway?`,
        confirmLabel: "Force delete",
        danger: true,
      });
      if (force) return mutate(["branch", "-D", ref.name], `Deleted branch ${ref.name}`);
    } else {
      app.addToast("error", message(err));
    }
    return false;
  } finally {
    gitStore.revision++;
  }
}

export async function mergeRef(ref: GitRef): Promise<boolean> {
  return mutate(["merge", "--no-edit", ref.name], `Merged ${ref.name}`);
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await clipboardWrite(text);
    app.addToast("info", `Copied ${what}`);
  } catch {
    app.addToast("error", "Could not copy to the clipboard");
  }
}
