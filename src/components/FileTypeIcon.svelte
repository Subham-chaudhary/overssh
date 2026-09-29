<script lang="ts">
  // VS Code-like icon for a file or folder name (docs/GUIDE.md §14.4.X). Falls
  // back to a Lucide icon until the icon manifest has loaded.
  import { onMount } from "svelte";
  import { fileIcon, fileIconsReady, loadFileIcons } from "../lib/fileIcons";
  import { settings } from "../lib/settings.svelte";
  import { THEMES } from "../lib/themes";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
  import FileIcon from "@lucide/svelte/icons/file";

  let {
    name,
    isDir = false,
    isOpen = false,
    class: className = "size-4",
  }: { name: string; isDir?: boolean; isOpen?: boolean; class?: string } = $props();

  let ready = $state(fileIconsReady());
  onMount(() => {
    if (!ready) void loadFileIcons().then(() => (ready = fileIconsReady()));
  });

  const light = $derived(!(THEMES[settings.theme]?.isDark ?? true));
  const icon = $derived(ready ? fileIcon(name, isDir, isOpen, light) : null);
</script>

{#if icon}
  <img
    src={icon.url}
    alt=""
    class={`shrink-0 ${className}`}
    data-icon={icon.id}
    draggable="false"
    decoding="async"
  />
{:else if isDir}
  {#if isOpen}<FolderOpenIcon class={`shrink-0 text-primary ${className}`} />{:else}<FolderIcon
      class={`shrink-0 text-primary ${className}`}
    />{/if}
{:else}
  <FileIcon class={`shrink-0 text-muted-foreground ${className}`} />
{/if}
