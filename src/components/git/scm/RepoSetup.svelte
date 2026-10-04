<script lang="ts">
  // Non-ready states of the Source Control view: off, not connected, git missing, not a repo.
  import { app } from "$lib/stores.svelte";
  import { gitStore } from "$lib/git/git.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import LoaderIcon from "@lucide/svelte/icons/loader-circle";

  let path = $state("");
  const scmState = $derived(gitStore.state);
  const dir = $derived(gitStore.startDir);

  $effect(() => {
    if (scmState === "norepo") path = dir;
  });

  function open(e: SubmitEvent): void {
    e.preventDefault();
    if (path.trim()) void gitStore.detect(path.trim());
  }
</script>

<div class="flex flex-col gap-3 p-3 text-[12px]" data-testid="scm-state-{scmState}">
  {#if scmState === "disabled"}
    <p class="text-muted-foreground">Source Control is turned off.</p>
    <Button size="sm" variant="outline" onclick={() => (app.showSettings = true)}>Open Settings</Button>
  {:else if scmState === "disconnected"}
    <p class="text-muted-foreground">Connect to a host to use Source Control for its repositories.</p>
  {:else if scmState === "detecting"}
    <p class="flex items-center gap-2 text-muted-foreground"><LoaderIcon class="size-3.5 animate-spin" /> Looking for a repository…</p>
  {:else if scmState === "nogit"}
    <p class="font-medium">git is not installed on this VM.</p>
    <p class="text-muted-foreground">Install it with the VM's package manager (for example <code class="font-mono">apt install git</code>), then refresh.</p>
    <Button size="sm" variant="outline" onclick={() => void gitStore.detect()}>Check again</Button>
  {:else if scmState === "norepo"}
    <p class="text-muted-foreground">
      The folder <code class="font-mono break-all text-foreground">{dir}</code> is not inside a git repository.
    </p>
    {#if gitStore.detectMessage}
      <p class="whitespace-pre-wrap text-destructive" data-testid="scm-detect-message">{gitStore.detectMessage}</p>
    {/if}
    <Button size="sm" disabled={gitStore.busy !== null} data-testid="scm-init" onclick={() => void gitStore.initRepo()}>
      Initialize Repository
    </Button>
    <form class="flex flex-col gap-1.5" onsubmit={open}>
      <label for="scm-open-path" class="text-[11px] font-medium text-muted-foreground">Or open a repository folder</label>
      <div class="flex gap-1.5">
        <Input id="scm-open-path" class="h-7 min-w-0 flex-1 text-[12px]" bind:value={path} spellcheck="false" data-testid="scm-open-path" />
        <Button size="sm" variant="outline" type="submit" data-testid="scm-open-repo">Open</Button>
      </div>
    </form>
  {/if}
</div>
