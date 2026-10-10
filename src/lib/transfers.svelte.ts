// Transfer jobs (docs/GUIDE.md §13.4.S). Module-level state; subscribes to the
// backend events on import so jobs keep updating while the panel is closed.

import * as api from "./api";
import { isAppError } from "./api";
import { app } from "./stores.svelte";
import { isReconnecting } from "./reconnect.svelte";
import { basename } from "./paths";
import type {
  ConflictPolicy,
  TransferConflictEvent,
  TransferDoneEvent,
  TransferKind,
  TransferProgressEvent,
  TransferSpec,
} from "./types";

export type JobState = "scanning" | "running" | "done" | "error" | "cancelled";

export interface TransferJob {
  id: string;
  kind: TransferKind;
  label: string;
  spec: TransferSpec;
  /** Cut across sessions: offer to delete the originals after a clean copy. */
  moveSource: boolean;
  state: JobState;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  currentPath: string;
  rateBps: number;
  etaSecs: number | null;
  error?: string;
  failed: number;
  skipped: number;
  startedAt: number;
  /** Ended because the SSH connection dropped: Retry waits for the session to come back. */
  connectionLost?: boolean;
}

export const transfers = $state<{
  jobs: TransferJob[];
  open: boolean;
  conflict: TransferConflictEvent | null;
}>({ jobs: [], open: false, conflict: null });

const early = new Map<string, { progress?: TransferProgressEvent; done?: TransferDoneEvent }>();
/** Conflicts of other jobs waiting behind the one on screen (`transfers.conflict`). */
const conflictQueue: TransferConflictEvent[] = [];
/** Finished jobs kept in the panel; older ones are dropped (a session can run thousands of small jobs). */
const MAX_FINISHED = 200;
const retrying = new Set<string>();
let lastLostToast = 0;
/** Auto-reconnect replaced a session id (old -> new); a late done event still finds its session. */
const remaps = new Map<string, string>();

const LOST_RE = /connection (to the server )?was lost|connection lost|session (closed|not found|is gone)|disconnected|no such session/i;

function follow(id: string): string {
  for (let i = 0; i < 20 && remaps.has(id); i++) id = remaps.get(id)!;
  return id;
}

/** The sessions a finished job needs for Retry are connected (and not mid-reconnect). */
export function sessionsReady(j: TransferJob): boolean {
  const ids = [j.spec.sessionId, ...(j.spec.kind === "copy" && j.spec.dstSessionId ? [j.spec.dstSessionId] : [])];
  return ids.every((id) => app.sessions.some((s) => s.id === id) && !isReconnecting(id));
}

/** Shows the next queued conflict, skipping jobs that already ended. */
function nextConflict(): void {
  while (conflictQueue.length > 0) {
    const c = conflictQueue.shift()!;
    const job = transfers.jobs.find((j) => j.id === c.jobId);
    if (!job || isActive(job)) {
      transfers.conflict = c;
      return;
    }
  }
  transfers.conflict = null;
}

/** A job ended: its pending conflict prompts are moot (the backend stopped waiting). */
function dropConflicts(jobId: string): void {
  for (let i = conflictQueue.length - 1; i >= 0; i--) if (conflictQueue[i].jobId === jobId) conflictQueue.splice(i, 1);
  if (transfers.conflict?.jobId === jobId) nextConflict();
}

function trimFinished(): void {
  let finished = transfers.jobs.filter((j) => !isActive(j)).length;
  for (let i = 0; i < transfers.jobs.length && finished > MAX_FINISHED; ) {
    if (!isActive(transfers.jobs[i])) {
      transfers.jobs.splice(i, 1);
      finished--;
    } else i++;
  }
}

function errorMessage(err: unknown): string {
  return isAppError(err) ? err.message : String(err);
}

export function isActive(j: TransferJob): boolean {
  return j.state === "scanning" || j.state === "running";
}

export function activeCount(): number {
  return transfers.jobs.filter(isActive).length;
}

/** 0..1 across all running jobs (by bytes). */
export function overallFraction(): number {
  let done = 0;
  let total = 0;
  for (const j of transfers.jobs.filter(isActive)) {
    if (j.bytesTotal > 0) {
      done += Math.min(j.bytesDone, j.bytesTotal);
      total += j.bytesTotal;
    }
  }
  return total > 0 ? done / total : 0;
}

export function fraction(j: TransferJob): number {
  if (j.state === "done") return 1;
  if (j.bytesTotal > 0) return Math.min(1, j.bytesDone / j.bytesTotal);
  if (j.filesTotal > 0) return Math.min(1, j.filesDone / j.filesTotal);
  return 0;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatEta(secs: number | null): string {
  if (secs === null) return "";
  if (secs < 60) return `${secs}s left`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s left`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m left`;
}

function applyProgress(job: TransferJob, p: TransferProgressEvent): void {
  if (!isActive(job)) return;
  job.state = p.scanning ? "scanning" : "running";
  job.bytesDone = p.bytesDone;
  job.bytesTotal = p.bytesTotal;
  job.filesDone = p.filesDone;
  job.filesTotal = p.filesTotal;
  job.currentPath = p.currentPath;
  job.rateBps = p.rateBps;
  job.etaSecs = p.etaSecs;
}

function applyDone(job: TransferJob, d: TransferDoneEvent): void {
  if (!isActive(job)) return; // a second done (or one after a local cancel) changes nothing
  job.failed = d.failed;
  job.skipped = d.skipped;
  job.filesDone = d.filesDone;
  job.bytesDone = d.bytesDone;
  job.rateBps = 0;
  job.etaSecs = null;
  if (d.cancelled) job.state = "cancelled";
  else if (d.error) {
    job.state = "error";
    job.error = d.error;
    if (LOST_RE.test(d.error)) {
      job.connectionLost = true;
      job.spec = { ...job.spec, sessionId: follow(job.spec.sessionId), ...(job.spec.dstSessionId ? { dstSessionId: follow(job.spec.dstSessionId) } : {}) };
    }
  } else job.state = "done";
  dropConflicts(job.id);
  trimFinished();
  void afterDone(job);
}

async function afterDone(job: TransferJob): Promise<void> {
  const { spec } = job;
  if (job.state === "done") app.addToast("success", `${job.label}: finished`);
  else if (job.state === "error" && job.connectionLost) {
    // One toast per disconnect, not one per job.
    if (Date.now() - lastLostToast > 3000) app.addToast("error", "Connection lost: transfers stopped. Retry them from the Transfers panel once reconnected.");
    lastLostToast = Date.now();
  } else if (job.state === "error") app.addToast("error", `${job.label}: ${job.error}`);
  if (spec.kind !== "download" && job.state !== "cancelled") {
    const target = spec.kind === "copy" ? spec.dstSessionId : spec.sessionId;
    if (target) {
      try {
        await app.refreshDir(target, spec.dest);
        const ex = app.workspaces[target]?.explorer;
        if (ex && spec.dest !== ex.cwd && !ex.expanded.has(spec.dest)) await app.expandDir(target, spec.dest);
      } catch {
        /* session may be gone */
      }
    }
  }
  if (job.moveSource && job.state === "done" && job.failed === 0 && job.skipped === 0) {
    const { deleteEntries } = await import("./fileops.svelte");
    await deleteEntries(spec.sessionId, spec.items, {
      title: "Finish move",
      message: `Copied ${job.label}. Delete the original${spec.items.length === 1 ? "" : "s"} from the source session now?`,
      confirmLabel: "Delete originals",
    });
  }
}

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  void api.onTransferProgress((p) => {
    const job = transfers.jobs.find((j) => j.id === p.jobId);
    if (job) applyProgress(job, p);
    else early.set(p.jobId, { ...early.get(p.jobId), progress: p });
  });
  void api.onTransferDone((d) => {
    const job = transfers.jobs.find((j) => j.id === d.jobId);
    if (job) applyDone(job, d);
    else early.set(d.jobId, { ...early.get(d.jobId), done: d });
  });
  void api.onTransferConflict((c) => {
    // Two jobs can clash at the same time: queue, never replace (the first job would wait forever).
    if (transfers.conflict && transfers.conflict.jobId !== c.jobId) conflictQueue.push(c);
    else transfers.conflict = c;
  });
}
listen();

export async function resolveConflict(policy: "overwrite" | "skip" | "newer" | "cancel"): Promise<void> {
  const c = transfers.conflict;
  nextConflict();
  if (c) await api.transferResolve(c.jobId, policy).catch(() => {});
}

function describe(spec: TransferSpec): string {
  const n = spec.items.length;
  if (n === 1) return basename(spec.items[0].replace(/\\/g, "/"));
  return `${n} items`;
}

/** Starts a job and tracks it. Returns the job id, or null if it could not start. */
export async function startTransfer(
  spec: TransferSpec,
  opts: { moveSource?: boolean; label?: string } = {},
): Promise<string | null> {
  const withPolicy: TransferSpec = { conflict: "ask" as ConflictPolicy, ...spec };
  try {
    const id = await api.transferStart(withPolicy);
    const verb = spec.kind === "upload" ? "Uploading" : spec.kind === "download" ? "Downloading" : "Copying";
    transfers.jobs.push({
      id,
      kind: spec.kind,
      label: opts.label ?? describe(spec),
      spec: withPolicy,
      moveSource: opts.moveSource ?? false,
      state: "scanning",
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 0,
      filesTotal: 0,
      currentPath: "",
      rateBps: 0,
      etaSecs: null,
      failed: 0,
      skipped: 0,
      startedAt: Date.now(),
    });
    const live = transfers.jobs[transfers.jobs.length - 1];
    app.addToast("info", `${verb} ${live.label}…`);
    const buffered = early.get(id);
    early.delete(id);
    if (buffered?.progress) applyProgress(live, buffered.progress);
    if (buffered?.done) applyDone(live, buffered.done);
    return id;
  } catch (err) {
    app.addToast("error", errorMessage(err));
    return null;
  }
}

export function startUpload(sessionId: string, localPaths: string[], remoteDir: string): Promise<string | null> {
  if (localPaths.length === 0) return Promise.resolve(null);
  return startTransfer({ kind: "upload", sessionId, items: localPaths, dest: remoteDir });
}

export function startDownload(
  sessionId: string,
  remotePaths: string[],
  localDir: string,
  rename?: string,
  conflict?: ConflictPolicy,
): Promise<string | null> {
  return startTransfer({ kind: "download", sessionId, items: remotePaths, dest: localDir, rename, conflict });
}

/** VM-to-VM: streamed read on `srcSession`, write on `dstSession`, no temp file. */
export function startCopy(
  srcSession: string,
  remotePaths: string[],
  dstSession: string,
  destDir: string,
  moveSource = false,
): Promise<string | null> {
  return startTransfer(
    { kind: "copy", sessionId: srcSession, dstSessionId: dstSession, items: remotePaths, dest: destDir },
    { moveSource },
  );
}

export function cancelJob(id: string): void {
  api.transferCancel(id).catch(() => {
    // The backend no longer knows the job (finished, or its session closed): stop showing it as running.
    const job = transfers.jobs.find((j) => j.id === id);
    if (job && isActive(job)) {
      job.state = "cancelled";
      job.rateBps = 0;
      job.etaSecs = null;
      dropConflicts(id);
    }
  });
}

/** Re-runs a failed/cancelled job, skipping what already arrived. */
export async function retryJob(id: string): Promise<void> {
  const job = transfers.jobs.find((j) => j.id === id);
  if (!job || isActive(job) || retrying.has(id)) return; // double click
  if (!sessionsReady(job)) {
    app.addToast("info", "Reconnect to the host first; Retry is available once the session is back.");
    return;
  }
  retrying.add(id);
  try {
    const spec = { ...job.spec, conflict: "skip" as ConflictPolicy };
    const newId = await startTransfer(spec, { moveSource: job.moveSource, label: job.label });
    if (newId) removeJob(id);
  } finally {
    retrying.delete(id);
  }
}

export function removeJob(id: string): void {
  const i = transfers.jobs.findIndex((j) => j.id === id);
  if (i >= 0) transfers.jobs.splice(i, 1);
}

export function clearFinished(): void {
  for (let i = transfers.jobs.length - 1; i >= 0; i--) {
    if (!isActive(transfers.jobs[i])) transfers.jobs.splice(i, 1);
  }
}

// Auto-reconnect (§13.4.A) gives the session a new id: point finished jobs at it so Retry works.
app.onSessionRemap((oldId, newId) => {
  remaps.set(oldId, newId);
  for (const j of transfers.jobs) {
    if (isActive(j)) continue;
    if (j.spec.sessionId === oldId) j.spec = { ...j.spec, sessionId: newId };
    if (j.spec.dstSessionId === oldId) j.spec = { ...j.spec, dstSessionId: newId };
  }
});
