<script lang="ts">
  // Changed-file list or tree for a commit (docs/GUIDE.md §14.4.G2).
  import FileTypeIcon from "../../FileTypeIcon.svelte";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import { flattenTree, STATUS_LABEL, type ChangeStatus, type FileChange } from "../../../lib/git/diff";

  let {
    files,
    mode,
    activePath = null,
    onpick,
  }: {
    files: readonly FileChange[];
    mode: "list" | "tree";
    activePath?: string | null;
    onpick: (file: FileChange) => void;
  } = $props();

  let collapsed = $state<ReadonlySet<string>>(new Set());
  const rows = $derived(flattenTree(files, collapsed));

  function toggle(path: string): void {
    const next = new Set(collapsed);
    if (!next.delete(path)) next.add(path);
    collapsed = next;
  }

  const letterColor: Record<ChangeStatus, string> = {
    A: "text-emerald-600 dark:text-emerald-400",
    M: "text-amber-600 dark:text-amber-400",
    D: "text-red-600 dark:text-red-400",
    R: "text-sky-600 dark:text-sky-400",
    C: "text-sky-600 dark:text-sky-400",
    T: "text-purple-600 dark:text-purple-400",
    U: "text-red-600 dark:text-red-400",
  };

  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
</script>

{#snippet stats(f: FileChange)}
  {#if f.binary}
    <span class="shrink-0 text-[11px] text-muted-foreground">binary</span>
  {:else}
    <span class="shrink-0 font-mono text-[11px]">
      {#if f.added}<span class="text-emerald-600 dark:text-emerald-400">+{f.added}</span>{/if}
      {#if f.deleted}<span class="ml-1 text-red-600 dark:text-red-400">-{f.deleted}</span>{/if}
    </span>
  {/if}
{/snippet}

<ul class="m-0 list-none p-0 text-[12px]" data-testid="changed-files" data-mode={mode}>
  {#if mode === "list"}
    {#each files as f (f.path)}
      <li>
        <button
          type="button"
          class={[
            "flex w-full items-center gap-1.5 px-2 py-[3px] text-left hover:bg-accent/50",
            activePath === f.path && "bg-accent text-accent-foreground",
          ]}
          data-testid="changed-file"
          data-path={f.path}
          data-status={f.status}
          title={f.oldPath ? `${f.oldPath} -> ${f.path} (${STATUS_LABEL[f.status]})` : `${f.path} (${STATUS_LABEL[f.status]})`}
          onclick={() => onpick(f)}
        >
          <span class={["w-3 shrink-0 text-center font-mono text-[11px] font-semibold", letterColor[f.status]]}>{f.status}</span>
          <FileTypeIcon name={nameOf(f.path)} class="size-4 shrink-0" />
          <span class="shrink-0">{nameOf(f.path)}</span>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">
            {#if f.oldPath}<span class="italic">{f.oldPath} -&gt; </span>{/if}{dirOf(f.path)}
          </span>
          {@render stats(f)}
        </button>
      </li>
    {/each}
  {:else}
    {#each rows as r (r.kind + r.path)}
      <li>
        {#if r.kind === "dir"}
          <button
            type="button"
            class="flex w-full items-center gap-1 py-[3px] pr-2 text-left hover:bg-accent/50"
            style={`padding-left:${6 + r.depth * 12}px`}
            data-testid="changed-dir"
            onclick={() => toggle(r.path)}
          >
            {#if collapsed.has(r.path)}<ChevronRightIcon class="size-3.5 shrink-0" />{:else}<ChevronDownIcon class="size-3.5 shrink-0" />{/if}
            <span class="truncate">{r.name}</span>
          </button>
        {:else if r.change}
          {@const f = r.change}
          <button
            type="button"
            class={[
              "flex w-full items-center gap-1.5 py-[3px] pr-2 text-left hover:bg-accent/50",
              activePath === f.path && "bg-accent text-accent-foreground",
            ]}
            style={`padding-left:${6 + r.depth * 12 + 14}px`}
            data-testid="changed-file"
            data-path={f.path}
            data-status={f.status}
            title={f.path}
            onclick={() => onpick(f)}
          >
            <FileTypeIcon name={r.name} class="size-4 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{r.name}</span>
            {@render stats(f)}
            <span class={["w-3 shrink-0 text-center font-mono text-[11px] font-semibold", letterColor[f.status]]}>{f.status}</span>
          </button>
        {/if}
      </li>
    {/each}
  {/if}
</ul>
