// Command-palette entries for Docker (docs/GUIDE.md §15.3.D). Called once from App.svelte's onMount.

import { registerCommand } from "../commands.svelte";
import { dockerStore, showDocker } from "./docker.svelte";

export function registerDockerCommands(): () => void {
  const stopStore = dockerStore.init();
  const stops = [
    registerCommand({ id: "docker.show", title: "Docker: Show", category: "Docker", keybinding: "Ctrl+Shift+D", run: showDocker }),
    registerCommand({
      id: "docker.refresh",
      title: "Docker: Refresh",
      category: "Docker",
      run: () => {
        showDocker();
        void dockerStore.detect();
      },
    }),
    registerCommand({
      id: "docker.prune",
      title: "Docker: Prune…",
      category: "Docker",
      run: () => {
        showDocker();
        dockerStore.select("system", "system");
        dockerStore.pruneOpen = true;
      },
    }),
    registerCommand({
      id: "docker.help",
      title: "Docker: Keyboard Shortcuts",
      category: "Docker",
      run: () => {
        showDocker();
        dockerStore.help = true;
      },
    }),
  ];
  return () => {
    for (const s of stops) s();
    stopStore();
  };
}
