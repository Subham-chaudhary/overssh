// Small presentation helpers shared by the Docker components.
import type { Container, PortMapping } from "./parse";
import { portLabel } from "./parse";

export function dotClass(c: Pick<Container, "state" | "health">): string {
  if (c.health === "unhealthy") return "bg-destructive";
  switch (c.state) {
    case "running":
      return c.health === "starting" ? "bg-warning" : "bg-success";
    case "paused":
    case "restarting":
      return "bg-warning";
    case "dead":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/50";
  }
}

export function matches(filter: string, ...fields: Array<string | undefined>): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return fields.some((x) => (x ?? "").toLowerCase().includes(f));
}

/** Published ports as "8080->80/tcp, 443/tcp +2" for rows. */
export function portsSummary(ports: PortMapping[], max = 3): string {
  const pub = ports.filter((p) => p.hostPort !== null);
  const all = pub.length ? pub : ports;
  const list = all.slice(0, max).map(portLabel);
  const more = all.length - list.length;
  return list.join(", ") + (more > 0 ? ` +${more}` : "");
}

/** Rows rendered before a "Show more" button appears. */
export const LIST_CAP = 300;

export const TABS: Record<string, { id: string; label: string }[]> = {
  container: [
    { id: "logs", label: "Logs" },
    { id: "stats", label: "Stats" },
    { id: "inspect", label: "Inspect" },
    { id: "env", label: "Env" },
    { id: "ports", label: "Ports" },
    { id: "top", label: "Top" },
    { id: "mounts", label: "Mounts" },
    { id: "files", label: "Files" },
  ],
  image: [
    { id: "overview", label: "Overview" },
    { id: "history", label: "History" },
    { id: "inspect", label: "Inspect" },
  ],
  project: [
    { id: "services", label: "Services" },
    { id: "logs", label: "Logs" },
    { id: "files", label: "Compose file" },
  ],
  volume: [
    { id: "overview", label: "Overview" },
    { id: "inspect", label: "Inspect" },
  ],
  network: [
    { id: "overview", label: "Overview" },
    { id: "inspect", label: "Inspect" },
  ],
};
