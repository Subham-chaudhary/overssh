<script lang="ts">
  // Crontab editor (docs/GUIDE.md §13.4.C). Parsing/description/next-runs are in
  // lib/cron.ts; unsaved edits live in lib/cron.svelte.ts so they survive tab switches.
  import { onMount } from "svelte";
  import { cronStore, type CronSession } from "../../lib/cron.svelte";
  import {
    PRESETS,
    commandForShell,
    commentAbove,
    describeSchedule,
    diffLines,
    formatRun,
    nextRuns,
    validateSchedule,
    type CronJob,
  } from "../../lib/cron";
  import { terminalStore } from "../../lib/terminal.svelte";
  import { app } from "../../lib/stores.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import Loader from "../Loader.svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import SaveIcon from "@lucide/svelte/icons/save";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import PlayIcon from "@lucide/svelte/icons/play";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import TrashIcon from "@lucide/svelte/icons/trash-2";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import UndoIcon from "@lucide/svelte/icons/undo-2";

  let { sessionId }: { sessionId: string } = $props();

  let cs = $state<CronSession | null>(null);
  $effect(() => {
    const s = cronStore.ensure(sessionId);
    cs = s;
    if (!s.loaded && !s.loading && !s.error) void s.load();
  });

  let now = $state(new Date());
  onMount(() => {
    const t = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(t);
  });

  // --- edit dialog -----------------------------------------------------------------------
  let editOpen = $state(false);
  let editId = $state<number | null>(null);
  let fSchedule = $state("* * * * *");
  let fCommand = $state("");
  let fComment = $state("");
  let fEnabled = $state(true);

  const check = $derived(validateSchedule(fSchedule));
  const fDesc = $derived(describeSchedule(fSchedule));
  const fNext = $derived(check.ok ? nextRuns(check.parsed, now, 3) : []);
  const canSubmit = $derived(check.ok && fCommand.trim().length > 0);
  const FIELD_LABELS = ["minute", "hour", "day", "month", "weekday"];
  const tokens = $derived(fSchedule.trim().startsWith("@") ? [] : fSchedule.trim().split(/\s+/));

  function setToken(i: number, v: string) {
    const t = tokens.length === 5 ? [...tokens] : ["*", "*", "*", "*", "*"];
    t[i] = v.trim().replace(/\s+/g, "") || "*";
    fSchedule = t.join(" ");
  }

  function openAdd() {
    editId = null;
    fSchedule = "0 * * * *";
    fCommand = "";
    fComment = "";
    fEnabled = true;
    editOpen = true;
  }

  function openEdit(j: CronJob, index: number) {
    editId = j.id;
    fSchedule = j.schedule;
    fCommand = j.command;
    fComment = cs ? commentAbove(cs.lines, index) : "";
    fEnabled = j.enabled;
    editOpen = true;
  }

  function submitEdit() {
    if (!cs || !canSubmit) return;
    cs.upsert(editId, { schedule: fSchedule, command: fCommand, enabled: fEnabled, comment: fComment });
    editOpen = false;
  }

  // --- save with diff confirmation --------------------------------------------------------
  let confirmOpen = $state(false);
  const diff = $derived(cs && confirmOpen ? diffLines(cs.original, cs.text) : []);

  function askSave() {
    if (!cs) return;
    if (cs.rawMode) {
      // validate raw text by round-tripping through the parser
      cs.setRawMode(false);
      cs.setRawMode(true);
    }
    confirmOpen = true;
  }

  async function doSave() {
    if (!cs) return;
    const ok = await cs.save();
    if (ok) confirmOpen = false;
  }

  function runNow(j: CronJob) {
    const cmd = commandForShell(j.command);
    terminalStore.openNew(sessionId, { command: cmd, title: `cron: ${cmd.slice(0, 24)}` }).catch((e) => {
      app.addToast("error", `Could not open a terminal: ${(e as { message?: string })?.message ?? String(e)}`);
    });
  }

  let showSystem = $state(false);
  function toggleSystem() {
    showSystem = !showSystem;
    if (showSystem && cs && !cs.system && !cs.systemLoading) void cs.loadSystem();
  }

  const nextText = (j: CronJob) => {
    if (!j.enabled) return [] as string[];
    return nextRuns(j.schedule, now, 3).map((d) => formatRun(d, now));
  };
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3" data-testid="cron-view">
  {#if !cs || (cs.loading && !cs.loaded)}
    <div class="flex flex-1 items-center justify-center"><Loader label="Reading crontab…" size="lg" /></div>
  {:else if cs.error && !cs.loaded}
    <div class="flex flex-1 flex-col items-center justify-center gap-2">
      <p class="max-w-lg text-center text-sm text-destructive" data-testid="cron-error">{cs.error}</p>
      <Button variant="outline" size="sm" onclick={() => cs && void cs.load()}>Retry</Button>
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={openAdd} disabled={cs.rawMode} data-testid="cron-add"><PlusIcon class="size-3.5" /> Add job</Button>
      <Button
        variant={cs.rawMode ? "secondary" : "outline"}
        size="sm"
        class="h-7 gap-1 px-2 text-[12px]"
        aria-pressed={cs.rawMode}
        onclick={() => cs && cs.setRawMode(!cs.rawMode)}
        data-testid="cron-raw-toggle"
      ><FileTextIcon class="size-3.5" /> Raw text</Button>
      <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={() => cs && void cs.load()} disabled={cs.loading || cs.dirty} title={cs.dirty ? "Save or discard your changes first" : "Re-read from the VM"} data-testid="cron-reload">
        <RefreshIcon class="size-3.5" /> Reload
      </Button>
      <div class="ml-auto flex items-center gap-2">
        {#if cs.dirty}
          <span class="rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warning" data-testid="cron-dirty">Unsaved changes</span>
          <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={() => cs?.discard()} data-testid="cron-discard"><UndoIcon class="size-3.5" /> Discard</Button>
        {/if}
        <Button size="sm" class="h-7 gap-1 px-2 text-[12px]" disabled={!cs.dirty || cs.saving} onclick={askSave} data-testid="cron-save">
          <SaveIcon class="size-3.5" /> Save…
        </Button>
      </div>
    </div>

    {#if cs.original === "" && !cs.dirty}
      <p class="text-[12px] text-muted-foreground" data-testid="cron-empty">This user has no crontab yet. Add a job to create one.</p>
    {/if}

    {#if cs.rawMode}
      <Textarea
        bind:value={cs.rawText}
        spellcheck={false}
        class="min-h-[320px] flex-1 font-mono text-[12px] leading-5"
        placeholder="# m h dom mon dow command"
        aria-label="Raw crontab"
        data-testid="cron-raw"
      />
    {:else}
      {#if cs.preserved.length}
        <div class="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="cron-env">
          <span class="text-muted-foreground">Environment:</span>
          {#each cs.preserved as l}
            <code class="rounded bg-muted px-1.5 py-0.5 font-mono">{l}</code>
          {/each}
        </div>
      {/if}
      <div class="overflow-auto rounded-md border border-border" data-testid="cron-table">
        <table class="w-full border-collapse text-[12px]">
          <thead class="bg-muted text-left text-muted-foreground">
            <tr>
              <th class="w-12 px-2 py-1 font-semibold">On</th>
              <th class="px-2 py-1 font-semibold">Schedule</th>
              <th class="px-2 py-1 font-semibold">Command</th>
              <th class="hidden px-2 py-1 font-semibold @4xl/mon:table-cell">Next runs</th>
              <th class="w-32 px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {#each cs.jobs as { job, index } (job.id)}
              {@const note = commentAbove(cs.lines, index)}
              {@const nexts = nextText(job)}
              <tr class={`border-t border-border align-top ${job.enabled ? "" : "opacity-55"}`} data-testid="cron-row" data-id={job.id} data-enabled={job.enabled}>
                <td class="px-2 py-1.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={job.enabled}
                    aria-label={job.enabled ? "Disable job" : "Enable job"}
                    data-testid="cron-toggle"
                    class={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${job.enabled ? "bg-primary" : "bg-muted-foreground/40"}`}
                    onclick={() => cs?.toggle(job.id)}
                  ><span class={`inline-block size-3 rounded-full bg-background transition-transform ${job.enabled ? "translate-x-3.5" : "translate-x-0.5"}`}></span></button>
                </td>
                <td class="px-2 py-1.5">
                  <code class="font-mono" data-testid="cron-schedule">{job.schedule}</code>
                  <div class="text-[11px] text-muted-foreground" data-testid="cron-desc">{describeSchedule(job.schedule)}</div>
                </td>
                <td class="max-w-0 px-2 py-1.5">
                  <code class="block truncate font-mono" title={job.command} data-testid="cron-command">{job.command}</code>
                  {#if note}<div class="truncate text-[11px] text-muted-foreground" title={note}># {note}</div>{/if}
                </td>
                <td class="hidden px-2 py-1.5 text-[11px] text-muted-foreground @4xl/mon:table-cell" data-testid="cron-next">
                  {#if !job.enabled}disabled
                  {:else if nexts.length === 0}{job.schedule === "@reboot" ? "at startup" : "never"}
                  {:else}{#each nexts as n}<div>{n}</div>{/each}{/if}
                </td>
                <td class="px-1 py-1">
                  <div class="flex justify-end gap-0.5">
                    <button type="button" class="rounded p-1 hover:bg-accent" title="Run now in a new terminal" aria-label="Run now" data-testid="cron-run" onclick={() => runNow(job)}><PlayIcon class="size-3.5" /></button>
                    <button type="button" class="rounded p-1 hover:bg-accent" title="Edit" aria-label="Edit job" data-testid="cron-edit" onclick={() => openEdit(job, index)}><PencilIcon class="size-3.5" /></button>
                    <button type="button" class="rounded p-1 hover:bg-accent" title="Duplicate" aria-label="Duplicate job" data-testid="cron-dup" onclick={() => cs?.duplicate(job.id)}><CopyIcon class="size-3.5" /></button>
                    <button type="button" class="rounded p-1 text-destructive hover:bg-accent" title="Delete" aria-label="Delete job" data-testid="cron-delete" onclick={() => cs?.remove(job.id)}><TrashIcon class="size-3.5" /></button>
                  </div>
                </td>
              </tr>
            {:else}
              <tr><td colspan="5" class="px-2 py-4 text-center text-muted-foreground">No jobs.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="text-[10px] text-muted-foreground">
        Next runs are computed on this PC in your local time zone; the VM's clock/time zone may differ. Comments, blank lines and environment lines are kept as they are when saving.
      </p>
    {/if}

    <div class="mt-1 border-t border-border pt-2">
      <button type="button" class="text-[12px] font-medium text-muted-foreground hover:text-foreground" onclick={toggleSystem} data-testid="cron-system-toggle">
        {showSystem ? "▾" : "▸"} System crontabs (/etc/crontab, /etc/cron.d, read-only)
      </button>
      {#if showSystem}
        <div class="mt-2 space-y-2" data-testid="cron-system">
          {#if cs.systemLoading}
            <Loader label="" size="sm" />
          {:else}
            {#each cs.system ?? [] as f (f.path)}
              <div class="rounded-md border border-border">
                <div class="border-b border-border bg-muted px-2 py-0.5 font-mono text-[11px]">{f.path}</div>
                {#if f.content !== null}
                  <pre class="max-h-48 overflow-auto px-2 py-1 font-mono text-[11px] leading-4">{f.content}</pre>
                {:else}
                  <p class="px-2 py-1 text-[11px] text-muted-foreground">{f.error}</p>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- Add / edit -->
<Dialog.Root bind:open={editOpen}>
  <Dialog.Content class="max-w-xl" data-testid="cron-dialog">
    <Dialog.Header>
      <Dialog.Title>{editId === null ? "Add cron job" : "Edit cron job"}</Dialog.Title>
      <Dialog.Description>Standard 5-field cron syntax, or an @name such as @reboot.</Dialog.Description>
    </Dialog.Header>
    <div class="space-y-3 text-[12px]">
      <div class="flex flex-wrap gap-1">
        {#each PRESETS as p}
          <button
            type="button"
            class={`rounded border px-1.5 py-0.5 hover:bg-accent ${fSchedule.trim() === p.schedule ? "border-primary bg-primary/15" : "border-border"}`}
            data-testid="cron-preset"
            onclick={() => (fSchedule = p.schedule)}
          >{p.label}</button>
        {/each}
      </div>
      <div>
        <label class="mb-1 block text-muted-foreground" for="cron-schedule-input">Schedule</label>
        <Input id="cron-schedule-input" bind:value={fSchedule} class="h-8 font-mono" aria-invalid={!check.ok} data-testid="cron-schedule-input" />
        {#if tokens.length === 5 || tokens.length === 0}
          <div class="mt-1.5 grid grid-cols-5 gap-1.5">
            {#each FIELD_LABELS as label, i}
              <label class="block text-[10px] uppercase text-muted-foreground">{label}
                <Input
                  value={tokens[i] ?? "*"}
                  class="mt-0.5 h-7 px-1.5 font-mono text-[12px]"
                  disabled={tokens.length === 0}
                  oninput={(e: Event) => setToken(i, (e.currentTarget as HTMLInputElement).value)}
                  data-testid={`cron-field-${i}`}
                />
              </label>
            {/each}
          </div>
        {/if}
        {#if check.ok}
          <p class="mt-1.5 font-medium" data-testid="cron-live-desc">{fDesc}</p>
          {#if fNext.length}
            <p class="text-[11px] text-muted-foreground" data-testid="cron-live-next">Next: {fNext.map((d) => formatRun(d, now)).join(" · ")}</p>
          {/if}
        {:else}
          <p class="mt-1.5 text-destructive" data-testid="cron-live-error">{check.error}</p>
        {/if}
      </div>
      <div>
        <label class="mb-1 block text-muted-foreground" for="cron-command-input">Command</label>
        <Input id="cron-command-input" bind:value={fCommand} class="h-8 font-mono" placeholder="/usr/local/bin/backup.sh >> /var/log/backup.log 2>&1" data-testid="cron-command-input" />
        <p class="mt-1 text-[10px] text-muted-foreground">Write a literal % as \%.</p>
      </div>
      <div>
        <label class="mb-1 block text-muted-foreground" for="cron-comment-input">Note (saved as a # comment above the job)</label>
        <Input id="cron-comment-input" bind:value={fComment} class="h-8" data-testid="cron-comment-input" />
      </div>
      <label class="flex items-center gap-2"><input type="checkbox" bind:checked={fEnabled} /> Enabled</label>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (editOpen = false)}>Cancel</Button>
      <Button disabled={!canSubmit} onclick={submitEdit} data-testid="cron-dialog-ok">{editId === null ? "Add" : "Apply"}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Save confirmation with diff -->
<Dialog.Root bind:open={confirmOpen}>
  <Dialog.Content class="max-w-2xl" data-testid="cron-confirm">
    <Dialog.Header>
      <Dialog.Title>Write crontab?</Dialog.Title>
      <Dialog.Description>This replaces the user's crontab on the VM with the text below (<code>crontab -</code>).</Dialog.Description>
    </Dialog.Header>
    <pre class="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-4" data-testid="cron-diff">{#each diff as d}<span class={d.op === "+" ? "block bg-success/20 text-success" : d.op === "-" ? "block bg-destructive/20 text-destructive" : "block text-muted-foreground"}>{d.op} {d.text}</span>{/each}</pre>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (confirmOpen = false)}>Cancel</Button>
      <Button disabled={cs?.saving} onclick={doSave} data-testid="cron-confirm-ok">{cs?.saving ? "Saving…" : "Save to crontab"}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
