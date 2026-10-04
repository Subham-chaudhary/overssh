<script lang="ts">
  // Commit message box with a split Commit button (Ctrl+Enter commits).
  import { gitStore } from "$lib/git/git.svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import CheckIcon from "@lucide/svelte/icons/check";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";

  let input = $state<HTMLTextAreaElement | null>(null);

  $effect(() => {
    if (gitStore.focusPending && input) {
      input.focus();
      gitStore.focusPending = false;
    }
  });

  const branch = $derived(gitStore.head.branch ?? "detached HEAD");
  const label = $derived(gitStore.amend ? "Amend" : gitStore.merging ? "Commit Merge" : "Commit");
  const busy = $derived(gitStore.busy !== null);

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      void gitStore.commit("smart");
    }
  }
</script>

<div class="flex flex-col gap-1.5 px-2 pt-1 pb-2">
  <textarea
    bind:this={input}
    bind:value={gitStore.message}
    rows="2"
    spellcheck="true"
    placeholder={`Message (Ctrl+Enter to commit on "${branch}")`}
    aria-label="Commit message"
    data-testid="scm-commit-input"
    class="field-sizing-content max-h-40 min-h-[3rem] w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
    onkeydown={onKeydown}
  ></textarea>
  <div class="flex">
    <button
      type="button"
      disabled={busy}
      data-testid="scm-commit"
      class="inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-primary px-2 text-[12px] font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      onclick={() => void gitStore.commit("smart")}
    >
      <CheckIcon class="size-3.5" />
      <span class="truncate">{label}</span>
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="inline-flex h-7 w-7 items-center justify-center rounded-r-md border-l border-primary-foreground/30 bg-primary text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="More commit actions"
        data-testid="scm-commit-menu"
      >
        <ChevronDownIcon class="size-3.5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="min-w-48">
        <DropdownMenu.Item data-testid="scm-commit-staged" onclick={() => void gitStore.commit("staged")}>Commit Staged</DropdownMenu.Item>
        <DropdownMenu.Item data-testid="scm-commit-all" onclick={() => void gitStore.commit("all")}>Commit All</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.CheckboxItem
          checked={gitStore.amend}
          data-testid="scm-amend"
          onCheckedChange={(v) => void gitStore.setAmend(v)}
        >
          Amend Last Commit
        </DropdownMenu.CheckboxItem>
        <DropdownMenu.CheckboxItem checked={gitStore.signOff} data-testid="scm-signoff" onCheckedChange={(v) => (gitStore.signOff = v)}>
          Sign-off
        </DropdownMenu.CheckboxItem>
        <DropdownMenu.Separator />
        <DropdownMenu.Item disabled={!gitStore.head.sha} data-testid="scm-undo-commit" onclick={() => void gitStore.undoLastCommit()}>
          Undo Last Commit
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</div>
