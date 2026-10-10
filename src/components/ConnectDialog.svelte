<script lang="ts">
  // Shared connect / edit-host form (docs/GUIDE.md §11 "Host profiles", §12
  // hosts redesign). Used by HostList.svelte (ssh-config hosts, pinned/saved
  // hosts) and QuickConnect.svelte ("New connection", i.e. no alias / no
  // existing saved host).
  //
  // `mode: "connect"` (default) only ever calls `app.connect()` — it NEVER
  // creates or edits a saved host. "Save as new host" is a separate, explicit
  // action (`saveHost`) available whenever the form differs from what it was
  // prefilled with.
  // `mode: "edit"` (a saved host's "Edit…") only updates that existing saved
  // host's fields via `updateHost` — no network call, no Connect button.
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { app } from "../lib/stores.svelte";
  import { saveHost, updateHost } from "../lib/hosts.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
  import XIcon from "@lucide/svelte/icons/x";

  export interface ConnectFormInitial {
    name?: string;
    hostname?: string;
    user?: string;
    port?: number;
    identityFile?: string | null;
    /** -J chain, prefilled from ssh config / the saved host (§13.4.P). */
    proxyJump?: string | null;
  }

  let {
    open = $bindable(false),
    mode = "connect",
    title = "Connect",
    alias = null,
    hostId = null,
    initial,
  }: {
    open: boolean;
    mode?: "connect" | "edit";
    title?: string;
    alias?: string | null;
    /** The saved host's id, when this form is editing (or was opened from) a
     * saved host. `null` for a `~/.ssh/config` host or a brand-new connection. */
    hostId?: string | null;
    initial?: ConnectFormInitial;
  } = $props();

  let name = $state("");
  let hostname = $state("");
  let user = $state("");
  let port = $state("22");
  let identityFile = $state<string | null>(null);
  let proxyJump = $state("");

  // Snapshot of the form's values right after the last reset-from-`initial`,
  // so "Save as new host" can tell whether anything has actually changed.
  let initialName = "";
  let initialHostname = "";
  let initialUser = "";
  let initialPort = "22";
  let initialIdentityFile: string | null = null;
  let initialProxyJump = "";

  // Reset the form from `initial` on the false -> true edge of `open` only
  // (not on every re-run of this effect while it stays open — bits-ui's
  // Dialog can re-settle `open` a couple of times while it mounts its
  // portal/focus trap, which re-ran this same effect well after the dialog
  // was visibly open and silently clobbered whatever the user had already
  // typed back to the initial values — the reproducible cause of "Save as
  // new host" never being enabled: `isDirty` kept comparing against a form
  // that kept getting reset out from under the user).
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      name = initial?.name ?? "";
      hostname = initial?.hostname ?? "";
      user = initial?.user ?? "";
      port = String(initial?.port ?? 22);
      identityFile = initial?.identityFile ?? null;
      proxyJump = initial?.proxyJump ?? "";
      initialProxyJump = proxyJump;
      initialName = name;
      initialHostname = hostname;
      initialUser = user;
      initialPort = port;
      initialIdentityFile = identityFile;
    }
    wasOpen = open;
  });

  const canSubmit = $derived(hostname.trim().length > 0 && !app.connecting);

  const isDirty = $derived(
    name !== initialName ||
      hostname !== initialHostname ||
      user !== initialUser ||
      port !== initialPort ||
      identityFile !== initialIdentityFile ||
      proxyJump !== initialProxyJump,
  );
  const canSaveAsNew = $derived(mode !== "edit" && isDirty && hostname.trim().length > 0);

  function resolvePort(): number {
    const portNum = Number(port);
    return Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 22;
  }

  /** An explicit port that is not 1..65535 (empty means the default 22). */
  function portInvalid(): boolean {
    const raw = port.trim();
    if (raw === "") return false;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return false;
    app.addToast("error", "Port must be a whole number from 1 to 65535.");
    return true;
  }

  /** "Save as new host" (docs/GUIDE.md §12): creates a new app-only saved
   * host from the current form fields without connecting — never available
   * in edit mode (which already saves the existing host via the regular Save
   * button) and disabled until something in the form actually differs from
   * what it was prefilled with. `saveHost` itself refuses to duplicate an
   * identical existing saved host. */
  function saveAsNewHost(): void {
    if (!canSaveAsNew || portInvalid()) return;
    const trimmedHost = hostname.trim();
    if (!trimmedHost) return;
    const resolvedUser = user.trim();
    const label = name.trim() || (resolvedUser ? `${resolvedUser}@${trimmedHost}` : trimmedHost);
    const saved = saveHost({
      name: label,
      hostname: trimmedHost,
      user: resolvedUser,
      port: resolvePort(),
      identityFile: identityFile || null,
      proxyJump: proxyJump.trim() || null,
    });
    app.addToast("success", `Saved ${saved.name}`);
    open = false;
  }

  async function browseKey(): Promise<void> {
    try {
      const path = await openDialog({ multiple: false, title: "Select private key" });
      if (typeof path === "string") identityFile = path;
    } catch (err) {
      app.addToast("error", `Cannot open the file picker: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!hostname.trim() || portInvalid()) return;
    const resolvedPort = resolvePort();

    if (mode === "edit" && hostId) {
      const trimmedName = name.trim();
      updateHost(hostId, {
        ...(trimmedName ? { name: trimmedName } : {}),
        hostname: hostname.trim(),
        user: user.trim(),
        port: resolvedPort,
        identityFile: identityFile || null,
        proxyJump: proxyJump.trim() || null,
      });
      open = false;
      return;
    }

    // Connect mode NEVER touches saved hosts — not on success, not on a
    // custom display name. Use "Save as new host" (or the saved host's own
    // Edit form) for that.
    const req = {
      alias: alias ?? undefined,
      hostname: hostname.trim(),
      user: user.trim() || undefined,
      port: resolvedPort,
      identityFile: identityFile || undefined,
      // Cleared a config-provided jump -> explicit "none"; untouched/empty -> let ssh config decide.
      proxyJump: proxyJump.trim() || (initialProxyJump ? "none" : undefined),
    };
    const label = name.trim() || (req.user ? `${req.user}@${req.hostname}` : req.hostname);
    open = false;
    await app.connect(req, label);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>
        {#if alias}
          From <span class="font-mono">~/.ssh/config</span> host <span class="font-mono">{alias}</span
          >. Fields you change here override the config for this connection.
        {:else}
          Nothing here is ever written to <span class="font-mono">~/.ssh/config</span>.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <form class="flex flex-col gap-3" onsubmit={submit}>
      <div class="flex flex-col gap-1.5">
        <Label for="cf-name">Name</Label>
        <Input id="cf-name" bind:value={name} placeholder={hostname || "Display name"} spellcheck="false" />
      </div>

      <div class="flex gap-2">
        <div class="flex flex-1 flex-col gap-1.5">
          <Label for="cf-host">Host</Label>
          <Input id="cf-host" bind:value={hostname} placeholder="example.com" spellcheck="false" required />
        </div>
        <div class="flex w-20 flex-col gap-1.5">
          <Label for="cf-port">Port</Label>
          <Input id="cf-port" bind:value={port} inputmode="numeric" placeholder="22" />
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="cf-user">User</Label>
        <Input id="cf-user" bind:value={user} placeholder="(current Windows user)" spellcheck="false" />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="cf-jump">Proxy jump (-J)</Label>
        <Input
          id="cf-jump"
          bind:value={proxyJump}
          placeholder="bastion, user@jump:2222 (optional)"
          spellcheck="false"
          data-testid="cf-proxy-jump"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="cf-key">Identity file</Label>
        <div class="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onclick={browseKey}>
            <FolderOpenIcon />
            {identityFile ? "Change…" : "Browse…"}
          </Button>
          {#if identityFile}
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={identityFile}
              >{identityFile}</span
            >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Clear identity file"
              onclick={() => (identityFile = null)}
            >
              <XIcon />
            </Button>
          {/if}
        </div>
      </div>

      <Dialog.Footer>
        {#if mode !== "edit"}
          <Button
            type="button"
            variant="secondary"
            disabled={!canSaveAsNew}
            onclick={saveAsNewHost}
            data-testid="save-as-new-host"
          >
            Save as new host
          </Button>
        {/if}
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
        {#if mode !== "edit"}
          <Button type="submit" disabled={!canSubmit}>Connect</Button>
        {:else}
          <Button type="submit">Save</Button>
        {/if}
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
