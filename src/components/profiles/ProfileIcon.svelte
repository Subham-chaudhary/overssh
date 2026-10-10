<script lang="ts">
  // Small coloured tile with a workspace profile's icon (docs/GUIDE.md §15.3.P).
  import type { Component } from "svelte";
  import ServerIcon from "@lucide/svelte/icons/server";
  import RocketIcon from "@lucide/svelte/icons/rocket";
  import CodeIcon from "@lucide/svelte/icons/code";
  import DatabaseIcon from "@lucide/svelte/icons/database";
  import GlobeIcon from "@lucide/svelte/icons/globe";
  import BoxIcon from "@lucide/svelte/icons/box";
  import FlaskIcon from "@lucide/svelte/icons/flask-conical";
  import WrenchIcon from "@lucide/svelte/icons/wrench";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import StarIcon from "@lucide/svelte/icons/star";
  import LayersIcon from "@lucide/svelte/icons/layers";

  let { icon = null, color = null, size = 20 }: { icon?: string | null; color?: string | null; size?: number } = $props();

  const ICONS: Record<string, Component<{ size?: number }>> = {
    server: ServerIcon,
    rocket: RocketIcon,
    code: CodeIcon,
    database: DatabaseIcon,
    globe: GlobeIcon,
    box: BoxIcon,
    flask: FlaskIcon,
    wrench: WrenchIcon,
    cloud: CloudIcon,
    terminal: TerminalIcon,
    shield: ShieldIcon,
    star: StarIcon,
  };
  const Icon = $derived((icon && ICONS[icon]) || LayersIcon);
</script>

<span
  class="inline-flex flex-none items-center justify-center rounded-md text-foreground"
  style={`width:${size}px;height:${size}px;background:${color ? `color-mix(in oklab, ${color} 22%, transparent)` : "var(--muted)"};color:${color ?? "var(--muted-foreground)"}`}
  data-testid="profile-icon"
  aria-hidden="true"
>
  <Icon size={Math.round(size * 0.62)} />
</span>
