// Command-palette entries for Source Control (docs/GUIDE.md §14.4.G1).
// Called once from App.svelte's onMount; also starts the store's repo detection.

import { registerCommand } from "../commands.svelte";
import { app } from "../stores.svelte";
import { gitStore } from "./git.svelte";

/** Shows the Source Control sidebar (and switches detection on). */
export function showSourceControl(): void {
  gitStore.activated = true;
  app.sidebarView = "scm";
}

export function registerGitCommands(): () => void {
  const stopStore = gitStore.init();
  /** Reveals the view, waits for repo detection, then runs `fn` if a repo is open. */
  const needsRepo = (fn: () => void | Promise<void>) => async (): Promise<void> => {
    showSourceControl();
    if (await gitStore.ensure()) await fn();
  };
  const cmd = (id: string, title: string, run: () => void | Promise<void>, keybinding?: string) =>
    registerCommand({ id: `git.${id}`, title: `Git: ${title}`, category: "Git", keybinding, run: () => void run() });

  const stops = [
    registerCommand({
      id: "git.show",
      title: "Git: Show Source Control",
      category: "Git",
      keybinding: "Ctrl+Shift+G",
      run: showSourceControl,
    }),
    cmd(
      "commit",
      "Commit",
      needsRepo(async () => {
        if (gitStore.message.trim() === "" && !gitStore.amend && !gitStore.merging) {
          gitStore.focusPending = true;
          return;
        }
        await gitStore.commit("smart");
      }),
    ),
    cmd("pull", "Pull", needsRepo(() => gitStore.pull())),
    cmd("push", "Push", needsRepo(() => gitStore.push())),
    cmd("fetch", "Fetch", needsRepo(() => gitStore.fetch())),
    cmd("sync", "Sync", needsRepo(() => gitStore.sync())),
    cmd(
      "checkout",
      "Checkout to…",
      needsRepo(() => {
        gitStore.pickerOpen = true;
      }),
    ),
    cmd("createBranch", "Create Branch…", needsRepo(() => gitStore.createBranch())),
    cmd("stash", "Stash", needsRepo(() => gitStore.stash())),
    cmd("stashUntracked", "Stash (Include Untracked)", needsRepo(() => gitStore.stash({ includeUntracked: true }))),
    cmd("refresh", "Refresh", needsRepo(() => gitStore.refresh(true))),
  ];
  return () => {
    for (const stop of stops) stop();
    stopStore();
  };
}
