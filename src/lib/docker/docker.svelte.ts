// Docker store (docs/GUIDE.md §15.3.D). Everything runs on the VM through
// `api.dockerRun` and the three event streams (logs / stats / events); parsing is in ./parse.
// Nothing runs until `dockerStore.activated` (set when the Docker view mounts or a Docker
// palette command runs).
//
// Load on the VM (docs/GUIDE.md §17): the event and stats streams run only while a Docker view
// is open and the window is visible (`live`); event-driven refreshes are throttled to the
// refresh's own cost; healthcheck `exec_*` events are ignored; `docker ps` never asks for
// sizes; `compose ls` runs only when the set of projects changes; `system df` runs only while
// a view that shows it is open.

import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import * as api from "../api";
import type { DockerOutput } from "../api";
import { app } from "../stores.svelte";
import { settings } from "../settings.svelte";
import { terminalStore } from "../terminal.svelte";
import { hostStore } from "../hosts.svelte";
import { addRule, startRule } from "../forwards.svelte";
import {
  LogBuffer,
  attachCommand,
  buildProjects,
  buildPruneCommands,
  buildRmArgs,
  composeArgs,
  composeValidateArgs,
  classifyDockerError,
  eventKind,
  execShellCommand,
  friendlyDockerError,
  parseComposeLs,
  parseContainers,
  parseDf,
  parseEventLine,
  parseImages,
  parseInfo,
  parseInspect,
  parseNetworks,
  parseReclaimed,
  parseStatLine,
  parseVolumes,
  type ComposeProject,
  type Container,
  type ContainerInspect,
  type DetectFailure,
  type DfRow,
  type DockerImage,
  type DockerInfo,
  type DockerNetwork,
  type DockerVolume,
  type EventKind,
  type PortMapping,
  type PruneChoice,
  type StatSample,
} from "./parse";

export type DockerPhase = "idle" | "detecting" | "ready" | DetectFailure;
export type SelKind = "container" | "image" | "volume" | "network" | "project" | "system";
export interface Selection {
  kind: SelKind;
  id: string;
}

export interface SessionDocker {
  phase: DockerPhase;
  message: string;
  info: DockerInfo | null;
  containers: Container[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  composeLs: ComposeProject[];
  df: DfRow[];
  loading: boolean;
  /** Which lists were fetched at least once. */
  loaded: boolean;
  /** Last list error (daemon went away etc.), shown as a banner. */
  listError: string;
}

export interface StatSeries {
  latest: StatSample;
  hist: StatSample[];
}

const HIST = 90;

function empty(): SessionDocker {
  return {
    phase: "idle",
    message: "",
    info: null,
    containers: [],
    images: [],
    volumes: [],
    networks: [],
    composeLs: [],
    df: [],
    loading: false,
    loaded: false,
    listError: "",
  };
}

function errText(e: unknown): string {
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Routes stream events to the component that owns the stream id; buffers early arrivals. */
class Router<T> {
  private handlers = new Map<string, (p: T) => void>();
  private early = new Map<string, T[]>();
  register(id: string, h: (p: T) => void): () => void {
    this.handlers.set(id, h);
    const q = this.early.get(id);
    if (q) {
      this.early.delete(id);
      for (const p of q) h(p);
    }
    return () => this.handlers.delete(id);
  }
  dispatch(id: string, p: T): void {
    const h = this.handlers.get(id);
    if (h) h(p);
    else {
      const q = this.early.get(id) ?? [];
      q.push(p);
      this.early.set(id, q);
      if (q.length === 1) setTimeout(() => this.early.delete(id), 10_000);
    }
  }
}

/** A log stream owned by the logs panel (container or compose project). */
export class LogSession {
  buffer = new LogBuffer(10_000);
  /** Bumped on every change; components depend on it. */
  rev = $state(0);
  ended = $state(false);
  exitCode = $state<number | null>(null);
  error = $state("");
  private streamId: string | null = null;
  private off: Array<() => void> = [];
  private stopped = false;

  constructor(
    readonly sessionId: string,
    readonly target: string,
    readonly compose: boolean,
  ) {}

  async start(opts: { follow: boolean; tail: number; timestamps: boolean; since?: string }): Promise<void> {
    this.stopped = false;
    this.ended = false;
    this.error = "";
    try {
      const id = await api.dockerLogsStart(this.sessionId, this.target, {
        follow: opts.follow,
        tail: opts.tail,
        timestamps: opts.timestamps,
        since: opts.since,
        compose: this.compose,
        command: settings.docker.command,
      });
      this.streamId = id;
      this.off.push(
        dockerStore.logChunks.register(id, (p) => {
          if (this.stopped) return;
          if (this.buffer.push(p.chunk, p.stream) > 0 || this.buffer.pending()) this.rev++;
        }),
        dockerStore.logEnds.register(id, (p) => {
          this.buffer.finish();
          this.ended = true;
          this.exitCode = p.code;
          this.rev++;
          this.cleanup();
        }),
      );
      if (this.stopped) void this.stop();
    } catch (e) {
      this.ended = true;
      this.error = errText(e);
    }
  }

  private cleanup(): void {
    for (const o of this.off) o();
    this.off = [];
    this.streamId = null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const id = this.streamId;
    if (id) {
      try {
        await api.dockerLogsStop(id);
      } catch {
        /* already gone */
      }
      // Drop the routes now: a stopped stream may never send its end event.
      if (this.streamId === id) this.cleanup();
    }
  }

  clear(): void {
    this.buffer.clear();
    this.rev++;
  }
}

class DockerStore {
  /** Set once the Docker view (or a palette command) was used; nothing runs before. */
  activated = $state(false);
  data = $state<Record<string, SessionDocker>>({});
  selection = $state<Selection | null>(null);
  /** Which list the main page shows on the left. */
  scope = $state<"containers" | "images" | "volumes" | "networks" | "projects">("containers");
  /** Ids (container id/name, image, ...) with a running action, for spinners. */
  busy = $state<Record<string, string>>({});
  stats = $state<Record<string, Record<string, StatSeries>>>({});
  /** The main page is mounted: keep the stats stream running. */
  statsWanted = $state(0);
  /** Whether sidebar lists should hide stopped containers etc. is in settings; this is the shared filter box. */
  filter = $state("");
  /** Detail tab per object kind, remembered. */
  tab = $state<Record<string, string>>({});
  /** Help overlay. */
  help = $state(false);
  /** Open dialogs (components read these). */
  runImage = $state<string | null>(null);
  pruneOpen = $state(false);
  /** Output of the last compose command per project (shown under the project detail). */
  composeOutput = $state<Record<string, { cmd: string; code: number | null; text: string; at: number; busy: boolean }>>({});
  /** Last validation result per compose file path. */
  composeCheck = $state<Record<string, { ok: boolean; message: string; at: number }>>({});

  readonly logChunks = new Router<api.DockerLogChunk>();
  readonly logEnds = new Router<api.DockerEndEvent>();
  private statsRoute = new Router<api.DockerLinesEvent>();
  private eventsRoute = new Router<api.DockerLinesEvent>();
  private streams: Record<string, { events?: string; stats?: string }> = {};
  private starting: Record<string, { events?: boolean; stats?: boolean }> = {};
  private dirty: Record<string, Set<EventKind | "all">> = {};
  private dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private inited = false;
  private lastStatPush: Record<string, number> = {};
  /** Docker views mounted now (`use()`), and views showing `system df` (`useDf()`). */
  private users = 0;
  private dfUsers = 0;
  /** Streams run only while a Docker view is open and the window is visible. Turns off
   * IDLE_GRACE_MS after that stops being true, so a quick switch does not restart them. */
  live = $state(false);
  private visible = typeof document === "undefined" || !document.hidden;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sessions whose streams were stopped while idle: reload their lists on resume. */
  private paused: Record<string, boolean> = {};
  /** Duration and end time of the last list refresh per session (refresh throttle). */
  private lastRefreshMs: Record<string, number> = {};
  private lastRefreshEnd: Record<string, number> = {};
  /** Compose project names seen in the last `docker ps`; `compose ls` reruns when they change. */
  private composeKey: Record<string, string> = {};
  /** The CLI rejected PS_FORMAT (an old docker or podman): use `{{json .}}` with `--size=false`. */
  private psLegacy: Record<string, boolean> = {};
  /** List refresh in flight per session, and the kinds asked for meanwhile (null = all). */
  private refreshing: Record<string, Promise<void>> = {};
  private refreshQueued: Record<string, Set<EventKind | "df"> | null> = {};
  /** Stream restarts in a row per `${sid}|kind` (backoff when `docker events` keeps failing). */
  private streamFailures: Record<string, number> = {};

  get sessionId(): string | null {
    return app.activeSessionId;
  }

  /** Data of the active session (an empty placeholder when none). */
  get cur(): SessionDocker {
    const id = this.sessionId;
    return (id && this.data[id]) || EMPTY;
  }

  get cli(): string {
    return settings.docker.command;
  }

  /** Reactive state for the sidebar/main page. */
  get state(): "disabled" | "disconnected" | DockerPhase {
    if (!settings.docker.enabled) return "disabled";
    if (!this.sessionId || !app.activeWorkspace) return "disconnected";
    return this.cur.phase;
  }

  // --- lifecycle ------------------------------------------------------------------

  /** Starts the effects and event listeners once; returns a disposer. */
  init(): () => void {
    if (this.inited) return () => {};
    this.inited = true;
    const offs: Array<Promise<() => void>> = [
      api.onDockerLogs((p) => this.logChunks.dispatch(p.streamId, p)),
      api.onDockerLogsEnd((p) => this.logEnds.dispatch(p.streamId, p)),
      api.onDockerStats((p) => this.statsRoute.dispatch(p.streamId, p)),
      api.onDockerEvents((p) => this.eventsRoute.dispatch(p.streamId, p)),
      api.onDockerEventsEnd((p) => this.onStreamEnd("events", p.streamId)),
      api.onDockerStatsEnd((p) => this.onStreamEnd("stats", p.streamId)),
    ];
    const onVisibility = () => {
      this.visible = !document.hidden;
      this.updateLive();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const stopRoot = $effect.root(() => {
      $effect(() => {
        const sid = app.activeSessionId;
        const on = this.activated && settings.docker.enabled && !!app.activeWorkspace;
        // Re-run when command/showStopped change: the list shape or the CLI differs.
        void settings.docker.command;
        if (!on || !sid) return;
        untrack(() => void this.ensure(sid));
      });
      $effect(() => {
        const sid = app.activeSessionId;
        const ready = sid ? this.data[sid]?.phase === "ready" : false;
        const want = this.statsWanted > 0;
        const live = this.live;
        untrack(() => {
          // Only the active session streams; others are stopped.
          for (const other of Object.keys(this.streams)) {
            if (other !== sid) this.stopStreams(other);
          }
          if (!sid || !ready) return;
          if (!live) {
            // No Docker view open, or the window is hidden: nothing runs on the VM.
            if (this.streams[sid]) this.paused[sid] = true;
            this.stopStreams(sid);
            return;
          }
          if (this.paused[sid]) {
            delete this.paused[sid];
            void this.refresh(sid); // events were missed while paused
          }
          void this.startEvents(sid);
          if (want) void this.startStats(sid);
          else this.stopStats(sid);
        });
      });
    });
    // Offer "Apply" when a compose file of a known project is saved in the editor.
    const seenMtime = new Map<string, number>();
    const stopSaves = $effect.root(() => {
      $effect(() => {
        const ws = app.activeWorkspace;
        if (!ws) return;
        const files = new Map<string, string>();
        for (const p of dockerStore.projects) for (const f of p.configFiles) files.set(f, p.name);
        for (const tab of ws.tabs) {
          const project = files.get(tab.path);
          if (!project) continue;
          const prev = seenMtime.get(tab.id);
          seenMtime.set(tab.id, tab.mtime);
          if (prev && prev !== tab.mtime && !tab.loading && tab.doc === tab.savedDoc) {
            untrack(() => this.offerApply(project, tab.path));
          }
        }
      });
    });
    this.pollTimer = setInterval(() => {
      const sid = this.sessionId;
      if (!sid || !this.live || this.data[sid]?.phase !== "ready") return;
      if (!this.streams[sid]?.events) void this.refresh(sid, ["containers"]);
    }, 10_000);
    app.onSessionDrop((old) => this.forget(old));
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopRoot();
      stopSaves();
      clearInterval(this.pollTimer);
      clearTimeout(this.idleTimer);
      this.inited = false;
      for (const p of offs) void p.then((f) => f());
    };
  }

  private forget(sid: string): void {
    delete this.streams[sid];
    delete this.refreshQueued[sid];
    for (const k of Object.keys(this.streamFailures)) if (k.startsWith(`${sid}|`)) delete this.streamFailures[k];
    delete this.data[sid];
    delete this.stats[sid];
    if (this.selection && this.sessionId === sid) this.selection = null;
  }

  private onStreamEnd(kind: "events" | "stats", streamId: string): void {
    for (const [sid, s] of Object.entries(this.streams)) {
      if (s[kind] === streamId) {
        delete s[kind];
        // Retry while the session lives and Docker is still ready: 5 s, doubling up to 2 min.
        const fk = `${sid}|${kind}`;
        const n = (this.streamFailures[fk] = (this.streamFailures[fk] ?? 0) + 1);
        setTimeout(() => {
          if (this.live && this.sessionId === sid && this.data[sid]?.phase === "ready" && app.sessions.some((x) => x.id === sid)) {
            if (kind === "events") void this.startEvents(sid);
            else if (this.statsWanted > 0) void this.startStats(sid);
          }
        }, Math.min(120_000, 5_000 * 2 ** Math.min(n - 1, 5)));
      }
    }
  }

  private async startEvents(sid: string): Promise<void> {
    if (this.streams[sid]?.events || this.starting[sid]?.events) return;
    (this.starting[sid] ??= {}).events = true;
    try {
      const id = await api.dockerEventsStart(sid, this.cli);
      // Switched session (or Docker went away) while starting: do not leave it running unseen.
      if (!this.live || this.sessionId !== sid || this.data[sid]?.phase !== "ready") {
        void api.dockerEventsStop(id).catch(() => {});
        return;
      }
      (this.streams[sid] ??= {}).events = id;
      this.eventsRoute.register(id, (p) => {
        if (p.lines.length > 0) delete this.streamFailures[`${sid}|events`];
        for (const line of p.lines) {
          const ev = parseEventLine(line);
          const kind = ev ? eventKind(ev) : null;
          if (kind) this.markDirty(sid, kind);
        }
      });
    } catch {
      /* polling covers it */
    } finally {
      this.starting[sid].events = false;
    }
  }

  private async startStats(sid: string): Promise<void> {
    if (this.streams[sid]?.stats || this.starting[sid]?.stats) return;
    (this.starting[sid] ??= {}).stats = true;
    try {
      const id = await api.dockerStatsStart(sid, undefined, this.cli);
      if (!this.live || this.sessionId !== sid || this.data[sid]?.phase !== "ready" || this.statsWanted <= 0) {
        void api.dockerStatsStop(id).catch(() => {});
        return;
      }
      (this.streams[sid] ??= {}).stats = id;
      this.statsRoute.register(id, (p) => {
        if (p.lines.length > 0) delete this.streamFailures[`${sid}|stats`];
        this.onStats(sid, p.lines);
      });
    } catch {
      /* stats are optional */
    } finally {
      this.starting[sid].stats = false;
    }
  }

  private onStats(sid: string, lines: string[]): void {
    const hintMs = Math.max(1, Math.min(10, settings.docker.statsIntervalHint)) * 1000;
    if (!this.stats[sid]) this.stats[sid] = {};
    const map = this.stats[sid];
    for (const line of lines) {
      const s = parseStatLine(line);
      if (!s) continue;
      const cur = map[s.name];
      if (!cur) {
        map[s.name] = { latest: s, hist: [s] };
        this.lastStatPush[`${sid}|${s.name}`] = s.t;
        continue;
      }
      cur.latest = s;
      const last = this.lastStatPush[`${sid}|${s.name}`] ?? 0;
      if (s.t - last >= hintMs - 150) {
        cur.hist.push(s);
        if (cur.hist.length > HIST) cur.hist.splice(0, cur.hist.length - HIST);
        this.lastStatPush[`${sid}|${s.name}`] = s.t;
      }
    }
  }

  private stopStats(sid: string): void {
    const id = this.streams[sid]?.stats;
    if (id) {
      void api.dockerStatsStop(id).catch(() => {});
      delete this.streams[sid].stats;
    }
  }

  private stopStreams(sid: string): void {
    const s = this.streams[sid];
    if (!s) return;
    if (s.events) void api.dockerEventsStop(s.events).catch(() => {});
    if (s.stats) void api.dockerStatsStop(s.stats).catch(() => {});
    delete this.streams[sid];
  }

  /** Event-driven refreshes: the first waits 350 ms to batch a burst (compose up sends dozens),
   * later ones wait until `refreshGap` after the previous refresh ended. Events arriving
   * meanwhile join the pending run instead of each starting one. */
  private markDirty(sid: string, kind: EventKind | "all"): void {
    (this.dirty[sid] ??= new Set()).add(kind);
    if (this.dirtyTimer !== undefined) return;
    const wait = Math.max(350, (this.lastRefreshEnd[sid] ?? 0) + this.refreshGap(sid) - Date.now());
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = undefined;
      for (const [id, set] of Object.entries(this.dirty)) {
        delete this.dirty[id];
        if (this.data[id]?.phase !== "ready") continue;
        void this.refresh(id, set.has("all") ? undefined : ([...set] as EventKind[]));
      }
    }, 350);
  }

  // --- running docker ---------------------------------------------------------------

  /** One docker call on the active (or given) session. Never throws for a non-zero exit. */
  async run(args: string[], opts: { sid?: string; stdin?: string } = {}): Promise<DockerOutput> {
    const sid = opts.sid ?? this.sessionId;
    if (!sid) throw new Error("No session");
    return api.dockerRun(sid, args, opts.stdin, this.cli);
  }

  /** Runs and returns stdout, or null (and fills `listError`) on failure. */
  private async text(sid: string, args: string[]): Promise<string | null> {
    return this.checked(sid, args, await this.run(args, { sid }));
  }

  /** stdout of a finished list command, or null (and fills `listError`) on failure. */
  private checked(sid: string, args: string[], out: DockerOutput): string | null {
    if (out.code !== 0) {
      const d = this.data[sid];
      if (d) {
        d.listError = friendlyDockerError(out.stderr, `docker ${args[0]} failed`);
        // The daemon stopped (or the socket became unreadable) mid-session: show the state screen
        // with its fix and "Check again" instead of stale lists.
        const why = classifyDockerError(out.code, out.stdout, out.stderr);
        if (d.phase === "ready" && (why === "daemon-down" || why === "denied" || why === "sudo-password")) {
          d.phase = why;
          d.message = d.listError;
          this.stopStreams(sid);
        }
      }
      return null;
    }
    if (out.truncated) {
      const d = this.data[sid];
      if (d) d.listError = `docker ${args[0]}: the output was too large and was cut; the list is incomplete.`;
    }
    return out.stdout;
  }

  async ensure(sid: string): Promise<void> {
    const d = this.data[sid];
    if (d && d.phase !== "idle" && !this.cliChanged(sid)) return;
    await this.detect(sid);
  }

  private detectedWith: Record<string, string> = {};
  private cliChanged(sid: string): boolean {
    return this.detectedWith[sid] !== undefined && this.detectedWith[sid] !== this.cli;
  }

  /** (Re)detects docker, then loads every list. */
  async detect(sid: string | null = this.sessionId): Promise<void> {
    if (!sid) return;
    this.stopStreams(sid);
    if (!this.data[sid]) this.data[sid] = empty();
    const d = this.data[sid]; // read back: the $state proxy, not the raw object
    d.phase = "detecting";
    d.message = "";
    this.detectedWith[sid] = this.cli;
    let out: DockerOutput;
    try {
      out = await this.run(["info", "--format", "{{json .}}"], { sid });
    } catch (e) {
      d.phase = "error";
      d.message = errText(e);
      return;
    }
    if (out.code === 0 && out.stdout.trim()) {
      d.info = parseInfo(out.stdout, this.cli);
      d.phase = "ready";
      await this.refresh(sid);
      return;
    }
    // `docker info` prints partial info and exits 1 when the daemon is unreachable.
    d.phase = classifyDockerError(out.code, out.stdout, out.stderr);
    d.message = friendlyDockerError(out.stderr, "docker is not usable");
  }

  /**
   * Reloads lists (all, or the given kinds). One refresh per session at a time: calls made
   * meanwhile are merged into one more run, so a slow host never piles up `docker ps` calls.
   */
  refresh(sid: string | null = this.sessionId, kinds?: Array<EventKind | "df">): Promise<void> {
    if (!sid) return Promise.resolve();
    const running = this.refreshing[sid];
    if (running) {
      const q = this.refreshQueued[sid];
      if (!kinds) this.refreshQueued[sid] = null;
      else if (q !== null) {
        const set = q ?? new Set<EventKind | "df">();
        for (const k of kinds) set.add(k);
        this.refreshQueued[sid] = set;
      }
      return running;
    }
    const p = (async () => {
      let next: Array<EventKind | "df"> | undefined = kinds;
      for (;;) {
        const t0 = Date.now();
        await this.doRefresh(sid, next);
        this.lastRefreshEnd[sid] = Date.now();
        this.lastRefreshMs[sid] = this.lastRefreshEnd[sid] - t0;
        if (!(sid in this.refreshQueued)) break;
        const q = this.refreshQueued[sid];
        delete this.refreshQueued[sid];
        next = q ? [...q] : undefined;
      }
    })().finally(() => delete this.refreshing[sid]);
    this.refreshing[sid] = p;
    return p;
  }

  /** Minimum time between event-driven refreshes: 2 s, or 3x the last refresh on a slow host
   * (at most 30 s), so the dashboard never keeps a busy VM busy. */
  private refreshGap(sid: string): number {
    return Math.min(30_000, Math.max(2_000, 3 * (this.lastRefreshMs[sid] ?? 0)));
  }

  /** `docker ps -a` output (one JSON object per line), or null on failure. */
  private async listContainers(sid: string): Promise<string | null> {
    const legacy = !!this.psLegacy[sid];
    const args = ["ps", "-a", "--no-trunc", ...(legacy ? ["--size=false", "--format", "{{json .}}"] : ["--format", PS_FORMAT])];
    const out = await this.run(args, { sid });
    if (!legacy && out.code !== 0 && /template|can't evaluate|not defined/i.test(out.stderr)) {
      this.psLegacy[sid] = true;
      return this.listContainers(sid);
    }
    return this.checked(sid, args, out);
  }

  /** A Docker view mounted; call the returned function on unmount. */
  use(): () => void {
    this.users++;
    this.activated = true;
    this.updateLive();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.users--;
      this.updateLive();
    };
  }

  /** A view showing `system df` mounted (system page, prune dialog). Loads it now. */
  useDf(): () => void {
    this.dfUsers++;
    void this.refresh(this.sessionId, ["df"]);
    return () => {
      this.dfUsers--;
    };
  }

  private updateLive(): void {
    clearTimeout(this.idleTimer);
    if (this.users > 0 && this.visible) {
      this.live = true;
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (!(this.users > 0 && this.visible)) this.live = false;
    }, IDLE_GRACE_MS);
  }

  private async doRefresh(sid: string, kinds?: Array<EventKind | "df">): Promise<void> {
    const d = this.data[sid];
    if (!d || d.phase !== "ready") return;
    d.loading = true;
    const want = (k: EventKind | "df") => !kinds || kinds.includes(k);
    try {
      d.listError = "";
      const jobs: Promise<void>[] = [];
      if (want("containers")) {
        jobs.push(
          (async () => {
            const t = await this.listContainers(sid);
            if (t === null) return;
            d.containers = parseContainers(t);
            // `compose ls` starts a second CLI and only adds config file paths: rerun it when
            // the set of projects changes, or on a full reload.
            const key = [...new Set(d.containers.map((c) => c.project ?? ""))].sort().join("\n");
            if (!kinds || key !== this.composeKey[sid]) {
              const ls = await this.run(["compose", "ls", "-a", "--format", "json"], { sid });
              d.composeLs = ls.code === 0 ? parseComposeLs(ls.stdout) : [];
              this.composeKey[sid] = key;
            }
          })(),
        );
      }
      if (want("images")) jobs.push(this.text(sid, ["images", "--format", "{{json .}}"]).then((t) => void (t !== null && (d.images = parseImages(t)))));
      if (want("volumes")) jobs.push(this.text(sid, ["volume", "ls", "--format", "{{json .}}"]).then((t) => void (t !== null && (d.volumes = parseVolumes(t)))));
      if (want("networks")) jobs.push(this.text(sid, ["network", "ls", "--no-trunc", "--format", "{{json .}}"]).then((t) => void (t !== null && (d.networks = parseNetworks(t)))));
      // `system df` walks every image layer, container and volume (moby#31951): only while a
      // view that shows it is open.
      if ((!kinds || kinds.includes("df")) && this.dfUsers > 0) {
        jobs.push(this.text(sid, ["system", "df", "--format", "{{json .}}"]).then((t) => void (t !== null && (d.df = parseDf(t)))));
      }
      await Promise.all(jobs);
      d.loaded = true;
      // Selection that vanished (removed in a terminal, by compose down, ...) falls back to nothing.
      // `selection` belongs to the active session only.
      const sel = this.selection;
      if (sel && sid === this.sessionId && d.phase === "ready") {
        const gone =
          (sel.kind === "container" && want("containers") && !d.containers.some((c) => c.id === sel.id)) ||
          (sel.kind === "image" && want("images") && !d.images.some((i) => i.id === sel.id || i.ref === sel.id)) ||
          (sel.kind === "volume" && want("volumes") && !d.volumes.some((v) => v.name === sel.id)) ||
          (sel.kind === "network" && want("networks") && !d.networks.some((n) => n.id === sel.id || n.name === sel.id));
        if (gone) this.selection = null;
      }
    } catch (e) {
      d.listError = errText(e);
    } finally {
      d.loading = false;
    }
  }

  // --- derived helpers ----------------------------------------------------------------

  get projects(): ComposeProject[] {
    const d = this.cur;
    return buildProjects(d.composeLs, d.containers);
  }

  container(id: string | undefined | null): Container | undefined {
    return id ? this.cur.containers.find((c) => c.id === id) : undefined;
  }

  statsFor(c: Container): StatSeries | undefined {
    const sid = this.sessionId;
    return sid ? this.stats[sid]?.[c.name] : undefined;
  }

  select(kind: SelKind, id: string): void {
    this.selection = { kind, id };
    const scope = { container: "containers", image: "images", volume: "volumes", network: "networks", project: "projects" }[kind as string];
    if (scope) this.scope = scope as typeof this.scope;
  }

  // --- actions ---------------------------------------------------------------------------

  /** Runs an action with busy state; toasts stderr on failure; refreshes `refresh` kinds. */
  async act(
    key: string,
    label: string,
    args: string[],
    opts: { refresh?: Array<EventKind | "df">; quiet?: boolean; stdin?: string } = {},
  ): Promise<DockerOutput | null> {
    const sid = this.sessionId;
    if (!sid) return null;
    // One action per object at a time (double click, key repeat): the second call is dropped.
    if (this.busy[key]) return null;
    this.busy[key] = label;
    try {
      const out = await this.run(args, { sid, stdin: opts.stdin });
      if (out.code !== 0) {
        app.addToast("error", `${label} failed: ${friendlyDockerError(out.stderr)}`);
        return null;
      }
      if (!opts.quiet) app.addToast("success", label);
      void this.refresh(sid, opts.refresh ?? ["containers"]);
      return out;
    } catch (e) {
      app.addToast("error", `${label} failed: ${errText(e)}`);
      return null;
    } finally {
      delete this.busy[key];
    }
  }

  containerAction(c: Container, verb: "start" | "stop" | "restart" | "pause" | "unpause" | "kill"): Promise<DockerOutput | null> {
    const past = { start: "Started", stop: "Stopped", restart: "Restarted", pause: "Paused", unpause: "Unpaused", kill: "Killed" }[verb];
    return this.act(c.id, `${past} ${c.name}`, [verb, c.id], { quiet: true });
  }

  /** Confirms (per settings) and removes. Returns true if removed. */
  async removeContainer(c: Container, force = false, volumes = false): Promise<boolean> {
    const out = await this.act(c.id, `Removed ${c.name}`, buildRmArgs(c.id, { force, volumes }), { refresh: ["containers", "volumes", "df"] });
    if (out && this.selection?.id === c.id) this.selection = null;
    return !!out;
  }

  async renameContainer(c: Container, name: string): Promise<boolean> {
    return !!(await this.act(c.id, `Renamed to ${name}`, ["rename", c.id, name]));
  }

  async confirm(title: string, message: string, confirmLabel: string, danger = true): Promise<boolean> {
    if (!settings.docker.confirmDestructive) return true;
    return app.ask({ title, message, confirmLabel, danger });
  }

  execShell(c: Container): void {
    const sid = this.sessionId;
    if (!sid) return;
    terminalStore.openNew(sid, { command: execShellCommand(this.cli, c.id), title: `docker: ${c.name}` }).catch((e) => app.addToast("error", `Could not open a terminal: ${errText(e)}`));
  }

  attach(c: Container): void {
    const sid = this.sessionId;
    if (!sid) return;
    terminalStore.openNew(sid, { command: attachCommand(this.cli, c.id), title: `attach: ${c.name}` }).catch((e) => app.addToast("error", `Could not open a terminal: ${errText(e)}`));
  }

  /** Runs any docker command line in a new terminal (pull progress, compose up, ...). */
  inTerminal(args: string[], title: string): void {
    const sid = this.sessionId;
    if (!sid) return;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const prefix = this.cli === "sudo docker" ? "sudo docker" : this.cli === "podman" ? "podman" : "docker";
    terminalStore.openNew(sid, { command: `${prefix} ${args.map(q).join(" ")}`, title }).catch((e) => app.addToast("error", `Could not open a terminal: ${errText(e)}`));
  }

  async inspectContainer(id: string): Promise<ContainerInspect | null> {
    const out = await this.run(["inspect", "--type", "container", id]);
    if (out.code !== 0) throw new Error(friendlyDockerError(out.stderr, "inspect failed"));
    return parseInspect(out.stdout);
  }

  /** Prune dialog action. Returns reclaimed bytes and any failure messages. */
  async prune(choice: PruneChoice): Promise<{ reclaimed: number; errors: string[] }> {
    const sid = this.sessionId;
    if (!sid) return { reclaimed: 0, errors: ["No session"] };
    let reclaimed = 0;
    const errors: string[] = [];
    if (this.busy["system"]) return { reclaimed: 0, errors: ["A prune is already running"] };
    this.busy["system"] = "Pruning";
    try {
      for (const args of buildPruneCommands(choice)) {
        const out = await this.run(args, { sid });
        if (out.code !== 0) errors.push(`${args.slice(0, 2).join(" ")}: ${friendlyDockerError(out.stderr)}`);
        else reclaimed += parseReclaimed(out.stdout);
      }
    } finally {
      delete this.busy["system"];
    }
    await this.refresh(sid, ["containers", "images", "volumes", "networks", "df"]);
    return { reclaimed, errors };
  }

  // --- ports / files ----------------------------------------------------------------------

  /** Adds (and starts) an L forward rule for a container port; falls back to a direct forward. */
  async forwardPort(c: Container, p: PortMapping): Promise<void> {
    const sid = this.sessionId;
    const s = app.sessions.find((x) => x.id === sid);
    if (!sid || !s) return;
    let targetHost = "127.0.0.1";
    let targetPort = p.hostPort ?? p.containerPort;
    if (!p.hostPort) {
      // Not published: reach the container IP directly.
      try {
        const i = await this.inspectContainer(c.id);
        const ip = i?.networks.find((n) => n.ip)?.ip;
        if (!ip) {
          app.addToast("error", "Container has no IP address to forward to");
          return;
        }
        targetHost = ip;
        targetPort = p.containerPort;
      } catch (e) {
        app.addToast("error", errText(e));
        return;
      }
    }
    const label = `${c.name}:${p.containerPort}`;
    const host = hostStore.items.find((h) => (h.alias && h.alias === s.label) || (h.hostname === s.hostname && (!h.user || h.user === s.user)));
    if (host) {
      const rule = addRule({
        host: host.key,
        kind: "L",
        bindAddress: "",
        bindPort: targetPort,
        targetHost,
        targetPort,
        label: `docker ${label}`,
        autoStart: false,
        tunnelOnly: false,
      });
      await startRule(rule.id);
      app.addToast("info", `Forwarding localhost:${targetPort} to ${label} (see Ports)`);
      return;
    }
    try {
      const info = await api.forwardStart(sid, { kind: "L", bindPort: targetPort, targetHost, targetPort, label: `docker ${label}` });
      app.addToast("success", `Forwarding localhost:${info.bindPort} to ${label}`);
    } catch (e) {
      app.addToast("error", errText(e));
    }
  }

  /** Opens the Explorer at a host path if it is readable. */
  async browseHostPath(path: string): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    try {
      await api.listDir(sid, path);
    } catch (e) {
      app.addToast("error", `Cannot read ${path}: ${errText(e)}${/permission/i.test(errText(e)) ? " (Docker volumes are usually root-only)" : ""}`);
      return;
    }
    app.sidebarView = "explorer";
    await app.navigateExplorer(sid, path);
  }

  /** Opens a remote file in the editor (switches away from the Docker page). */
  async openFile(path: string): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    app.sidebarView = "explorer";
    await app.openFile(sid, path);
  }

  // --- compose ---------------------------------------------------------------------------

  /** Runs `docker compose …` for a project and records the output for the panel. Returns success. */
  async composeRun(project: string, label: string, sub: string[], opts: { toast?: boolean } = {}): Promise<boolean> {
    const sid = this.sessionId;
    const p = this.projects.find((x) => x.name === project);
    if (!sid) return false;
    const args = composeArgs(project, sub, { files: p?.configFiles, workdir: p?.workingDir });
    const cmd = `${this.cli} ${args.join(" ")}`;
    this.composeOutput[project] = { cmd, code: null, text: "", at: Date.now(), busy: true };
    this.busy[`proj:${project}`] = label;
    try {
      const out = await this.run(args, { sid });
      this.composeOutput[project] = { cmd, code: out.code, text: (out.stdout + (out.stderr ? (out.stdout ? "\n" : "") + out.stderr : "")).trim(), at: Date.now(), busy: false };
      if (opts.toast !== false) {
        if (out.code === 0) app.addToast("success", label);
        else app.addToast("error", `${label} failed: ${friendlyDockerError(out.stderr)}`);
      }
      void this.refresh(sid, ["containers", "networks", "volumes", "df"]);
      return out.code === 0;
    } catch (e) {
      this.composeOutput[project] = { cmd, code: null, text: errText(e), at: Date.now(), busy: false };
      app.addToast("error", `${label} failed: ${errText(e)}`);
      return false;
    } finally {
      delete this.busy[`proj:${project}`];
    }
  }

  /** `compose -f … config -q` on the project's files. Errors land in composeCheck per file. */
  async validateCompose(project: string): Promise<boolean> {
    const sid = this.sessionId;
    const p = this.projects.find((x) => x.name === project);
    if (!sid || !p || p.configFiles.length === 0) return false;
    const out = await this.run(composeValidateArgs(p.configFiles, p.workingDir), { sid });
    const ok = out.code === 0;
    const message = ok ? "" : friendlyDockerError(out.stderr, "invalid compose file");
    for (const f of p.configFiles) this.composeCheck[f] = { ok, message, at: Date.now() };
    return ok;
  }

  private offerApply(project: string, path: string): void {
    const name = path.slice(path.lastIndexOf("/") + 1);
    toast.info(`Saved ${name}`, {
      description: `Apply to project "${project}"?`,
      duration: 12_000,
      action: { label: "Apply (docker compose up -d)", onClick: () => void this.applyCompose(project) },
    });
  }

  /** Validate, then `up -d`; the output stays in the project's panel. */
  async applyCompose(project: string): Promise<void> {
    app.sidebarView = "docker";
    this.select("project", project);
    this.tab.project = "files";
    if (!(await this.validateCompose(project))) {
      app.addToast("error", "Compose file is invalid; fix it first (see Compose file tab)");
      return;
    }
    await this.composeRun(project, `Applied ${project}`, ["up", "-d"]);
  }

  newLogSession(target: string, compose = false): LogSession | null {
    const sid = this.sessionId;
    return sid ? new LogSession(sid, target, compose) : null;
  }
}

const EMPTY: SessionDocker = empty();

/** Streams keep running this long after the last Docker view closes or the window hides. */
const IDLE_GRACE_MS = 30_000;

/** The `docker ps` fields the UI reads. Not `{{json .}}`: a template that mentions `.Size` makes
 * the CLI compute every container's writable-layer size, a disk walk per container on each call
 * (docker/for-linux#1179). */
const PS_FORMAT =
  '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"Command":{{json .Command}},' +
  '"State":{{json .State}},"Status":{{json .Status}},"Ports":{{json .Ports}},"Labels":{{json .Labels}},' +
  '"Networks":{{json .Networks}},"Mounts":{{json .Mounts}},"CreatedAt":{{json .CreatedAt}},"RunningFor":{{json .RunningFor}}}';

export const dockerStore = new DockerStore();

/** Shows the Docker sidebar/page and switches the store on. */
export function showDocker(): void {
  dockerStore.activated = true;
  app.sidebarView = "docker";
}
