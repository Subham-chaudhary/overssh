<script lang="ts">
  // Add / edit a forward rule, or paste an `ssh -L … host` command (§13.4.P).
  import { untrack } from "svelte";
  import { hostStore } from "../../lib/hosts.svelte";
  import { addRule, importSshCommand, updateRule } from "../../lib/forwards.svelte";
  import { parseSshCommand } from "../../lib/sshCommand";
  import { app } from "../../lib/stores.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import type { ForwardKind, ForwardRule } from "../../lib/types";

  let {
    open = $bindable(false),
    editing = null,
    startInPaste = false,
  }: { open: boolean; editing?: ForwardRule | null; startInPaste?: boolean } = $props();

  let tab = $state<"form" | "paste">("form");
  let host = $state("");
  let kind = $state<ForwardKind>("L");
  let label = $state("");
  let bindAddress = $state("");
  let bindPort = $state("");
  let targetHost = $state("127.0.0.1");
  let targetPort = $state("");
  let tunnelOnly = $state(true);
  let autoStart = $state(false);
  let pasted = $state("");

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      untrack(() => {
        const r = editing;
        tab = !r && startInPaste ? "paste" : "form";
        host = r?.host ?? hostStore.items[0]?.key ?? "";
        kind = r?.kind ?? "L";
        label = r?.label ?? "";
        bindAddress = r?.bindAddress ?? "";
        bindPort = r ? String(r.bindPort) : "";
        targetHost = r?.targetHost ?? "127.0.0.1";
        targetPort = r ? String(r.targetPort) : "";
        tunnelOnly = r?.tunnelOnly ?? true;
        autoStart = r?.autoStart ?? false;
        pasted = "";
      });
    }
    wasOpen = open;
  });

  function toPort(s: string): number | null {
    if (!/^\d+$/.test(s.trim())) return null;
    const n = Number(s);
    return n >= 0 && n <= 65535 ? n : null;
  }

  const bindPortNum = $derived(toPort(bindPort));
  const targetPortNum = $derived(toPort(targetPort));
  const formValid = $derived(
    host !== "" &&
      bindPortNum !== null &&
      (kind === "D" || (targetHost.trim() !== "" && targetPortNum !== null && targetPortNum > 0)),
  );

  const preview = $derived(tab === "paste" && pasted.trim() ? parseSshCommand(pasted) : null);
  const previewResult = $derived(
    preview ? importSshCommand(pasted, { dryRun: true }) : null,
  );

  function submitForm(e: SubmitEvent): void {
    e.preventDefault();
    if (!formValid || bindPortNum === null) return;
    const fields = {
      host,
      kind,
      bindAddress: bindAddress.trim(),
      bindPort: bindPortNum,
      targetHost: kind === "D" ? "" : targetHost.trim(),
      targetPort: kind === "D" ? 0 : (targetPortNum ?? 0),
      label: label.trim(),
      autoStart,
      tunnelOnly,
    };
    if (editing) {
      updateRule(editing.id, fields);
    } else {
      addRule(fields);
    }
    open = false;
  }

  function submitPaste(e: SubmitEvent): void {
    e.preventDefault();
    const res = importSshCommand(pasted);
    if (res.errors.length > 0 || res.rules.length === 0) return;
    app.addToast("success", `Added ${res.rules.length} forward${res.rules.length === 1 ? "" : "s"}`);
    open = false;
  }

  const kinds: { id: ForwardKind; title: string; hint: string }[] = [
    { id: "L", title: "Local (-L)", hint: "Listen here, connect from the VM" },
    { id: "R", title: "Remote (-R)", hint: "Listen on the VM, connect from here" },
    { id: "D", title: "Dynamic (-D)", hint: "Local SOCKS5 proxy through the VM" },
  ];
  const selectClass =
    "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-md" data-testid="rule-dialog">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit forward" : "Forward a port"}</Dialog.Title>
      <Dialog.Description>
        {#if kind === "L" && tab === "form"}
          Like <span class="font-mono">ssh -L bind:port:target:port host</span>.
        {:else if kind === "R" && tab === "form"}
          Like <span class="font-mono">ssh -R bind:port:target:port host</span>.
        {:else if tab === "form"}
          Like <span class="font-mono">ssh -D port host</span>.
        {:else}
          Paste an <span class="font-mono">ssh</span> command; each -L / -R / -D becomes a rule.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    {#if !editing}
      <div class="flex gap-1" role="tablist">
        <Button
          type="button"
          size="sm"
          variant={tab === "form" ? "secondary" : "ghost"}
          onclick={() => (tab = "form")}
          data-testid="rule-tab-form">Fields</Button
        >
        <Button
          type="button"
          size="sm"
          variant={tab === "paste" ? "secondary" : "ghost"}
          onclick={() => (tab = "paste")}
          data-testid="rule-tab-paste">Paste ssh command</Button
        >
      </div>
    {/if}

    {#if tab === "paste" && !editing}
      <form class="flex flex-col gap-3" onsubmit={submitPaste}>
        <Textarea
          bind:value={pasted}
          rows={3}
          spellcheck="false"
          class="font-mono text-xs"
          placeholder="ssh -L 6443:127.0.0.1:6443 -N -J bastion chalkdoor-k8s"
          data-testid="paste-input"
        />
        {#if previewResult && preview}
          <ul class="flex flex-col gap-1 text-xs" data-testid="paste-preview">
            {#each preview.forwards as f}
              <li class="font-mono text-foreground">
                {f.kind}
                {f.bindAddress || "*"}:{f.bindPort}{f.kind === "D" ? "" : ` -> ${f.targetHost}:${f.targetPort}`}
              </li>
            {/each}
            {#if preview.host}
              <li class="text-muted-foreground">
                Host: <span class="font-mono">{preview.host}</span>{preview.proxyJump
                  ? ` via ${preview.proxyJump}`
                  : ""}{preview.tunnelOnly ? " (tunnel-only, -N)" : ""}
              </li>
            {/if}
            {#each previewResult.notes as n}
              <li class="text-muted-foreground">{n}</li>
            {/each}
            {#each previewResult.errors as err}
              <li class="text-destructive">{err}</li>
            {/each}
          </ul>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
          <Button
            type="submit"
            disabled={!previewResult || previewResult.errors.length > 0}
            data-testid="paste-add">Add forwards</Button
          >
        </Dialog.Footer>
      </form>
    {:else}
      <form class="flex flex-col gap-3" onsubmit={submitForm}>
        <div class="flex flex-col gap-1.5">
          <Label for="rf-host">Host</Label>
          <select id="rf-host" class={selectClass} bind:value={host} data-testid="rule-host">
            {#each hostStore.items as h (h.key)}
              <option value={h.key}>{h.name}{h.user ? ` (${h.user}@${h.hostname})` : ` (${h.hostname})`}</option>
            {/each}
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label>Type</Label>
          <div class="flex gap-1">
            {#each kinds as k (k.id)}
              <Button
                type="button"
                size="sm"
                class="flex-1"
                variant={kind === k.id ? "default" : "outline"}
                title={k.hint}
                onclick={() => (kind = k.id)}
                data-testid={`rule-kind-${k.id}`}>{k.title}</Button
              >
            {/each}
          </div>
        </div>

        <div class="flex gap-2">
          <div class="flex flex-1 flex-col gap-1.5">
            <Label for="rf-bind">{kind === "R" ? "Remote bind address" : "Bind address"}</Label>
            <Input
              id="rf-bind"
              bind:value={bindAddress}
              placeholder={kind === "R" ? "localhost" : "127.0.0.1"}
              spellcheck="false"
              data-testid="rule-bind-address"
            />
          </div>
          <div class="flex w-24 flex-col gap-1.5">
            <Label for="rf-bport">{kind === "R" ? "Remote port" : "Local port"}</Label>
            <Input id="rf-bport" bind:value={bindPort} inputmode="numeric" placeholder="6443" data-testid="rule-bind-port" />
          </div>
        </div>

        {#if kind !== "D"}
          <div class="flex gap-2">
            <div class="flex flex-1 flex-col gap-1.5">
              <Label for="rf-thost">{kind === "R" ? "Local target host" : "Target host (as seen from the VM)"}</Label>
              <Input id="rf-thost" bind:value={targetHost} spellcheck="false" data-testid="rule-target-host" />
            </div>
            <div class="flex w-24 flex-col gap-1.5">
              <Label for="rf-tport">Target port</Label>
              <Input id="rf-tport" bind:value={targetPort} inputmode="numeric" placeholder="6443" data-testid="rule-target-port" />
            </div>
          </div>
        {/if}

        <div class="flex flex-col gap-1.5">
          <Label for="rf-label">Label</Label>
          <Input id="rf-label" bind:value={label} placeholder="(optional) e.g. k8s API" data-testid="rule-label" />
        </div>

        <label class="flex items-center justify-between gap-3 text-sm">
          <span>
            Tunnel only (-N)
            <span class="block text-xs text-muted-foreground"
              >Connect in the background; no explorer or terminal opens.</span
            >
          </span>
          <Switch bind:checked={tunnelOnly} data-testid="rule-tunnel-only" />
        </label>
        <label class="flex items-center justify-between gap-3 text-sm">
          <span>
            Start automatically
            <span class="block text-xs text-muted-foreground"
              >On app launch (tunnel only) or when the host connects.</span
            >
          </span>
          <Switch bind:checked={autoStart} data-testid="rule-autostart" />
        </label>

        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
          <Button type="submit" disabled={!formValid} data-testid="rule-save">{editing ? "Save" : "Add"}</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
