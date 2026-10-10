// Crontab editor state per session (docs/GUIDE.md §13.4.C). Pure logic lives in
// cron.ts; this holds the loaded text, the unsaved edits (they survive switching
// dashboard tabs) and the read/write calls.

import * as api from "./api";
import { app } from "./stores.svelte";
import { jobLine, newJob, parseCrontab, serializeCrontab, setCommentAbove, type CronJob, type CronLine } from "./cron";

export interface SystemCron {
  path: string;
  content: string | null;
  error: string | null;
}

const errMsg = (e: unknown) => (e as { message?: string })?.message ?? String(e);

export class CronSession {
  sessionId: string;
  loading = $state(false);
  loaded = $state(false);
  saving = $state(false);
  error = $state<string | null>(null);
  /** Text as last read from / written to the VM. */
  original = $state("");
  lines = $state<CronLine[]>([]);
  rawMode = $state(false);
  rawText = $state("");
  system = $state<SystemCron[] | null>(null);
  systemLoading = $state(false);

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** The text that would be written now. */
  get text(): string {
    return this.rawMode ? this.rawText : serializeCrontab(this.lines);
  }

  get dirty(): boolean {
    return this.loaded && this.text !== this.original;
  }

  get jobs(): { job: CronJob; index: number }[] {
    const out: { job: CronJob; index: number }[] = [];
    this.lines.forEach((l, index) => {
      if (l.kind === "job") out.push({ job: l, index });
    });
    return out;
  }

  /** Environment lines (MAILTO=, PATH=, ...), shown read-only. */
  get preserved(): string[] {
    return this.lines.flatMap((l) => (l.kind === "env" ? [l.raw.trim()] : []));
  }

  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    try {
      const text = await api.cronRead(this.sessionId);
      this.original = text;
      this.lines = parseCrontab(text);
      this.rawText = text;
      this.loaded = true;
    } catch (e) {
      this.error = errMsg(e);
    } finally {
      this.loading = false;
    }
  }

  async save(): Promise<boolean> {
    if (this.saving) return false; // double click while writing
    if (this.rawMode) this.lines = parseCrontab(this.rawText);
    const text = serializeCrontab(this.lines);
    // Lines that are neither jobs, comments nor VAR=value: crontab rejects the whole file on a bad one.
    const bad: number[] = [];
    this.lines.forEach((l, i) => {
      if (l.kind === "unknown") bad.push(i + 1);
    });
    if (bad.length > 0) {
      const ok = await app.ask({
        title: "Save crontab",
        message: `Line${bad.length === 1 ? "" : "s"} ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? "…" : ""} ${bad.length === 1 ? "is not a valid cron job" : "are not valid cron jobs"} (expected 5 schedule fields or @special, then a command). crontab may refuse the file. Save anyway?`,
        confirmLabel: "Save anyway",
      });
      if (!ok) return false;
    }
    this.saving = true;
    try {
      // Someone (or another OverSSH window) changed the crontab since it was loaded: do not overwrite silently.
      const remote = await api.cronRead(this.sessionId).catch(() => null);
      if (remote !== null && remote !== this.original && remote !== text) {
        const ok = await app.ask({
          title: "Crontab changed on the VM",
          message: "The crontab was changed on the VM after it was loaded here. Saving replaces those changes with yours.",
          confirmLabel: "Overwrite",
          danger: true,
        });
        if (!ok) {
          this.saving = false;
          return false;
        }
      }
      await api.cronWrite(this.sessionId, text);
    } catch (e) {
      this.saving = false;
      app.addToast("error", `Could not save crontab: ${errMsg(e)}`);
      return false;
    }
    this.saving = false;
    await this.load();
    app.addToast("success", "Crontab saved");
    return true;
  }

  discard(): void {
    this.lines = parseCrontab(this.original);
    this.rawText = this.original;
  }

  setRawMode(on: boolean): void {
    if (on === this.rawMode) return;
    if (on) this.rawText = serializeCrontab(this.lines);
    else this.lines = parseCrontab(this.rawText);
    this.rawMode = on;
  }

  toggle(id: number): void {
    const j = this.find(id);
    if (!j) return;
    j.enabled = !j.enabled;
    j.raw = null;
  }

  remove(id: number): void {
    const i = this.lines.findIndex((l) => l.kind === "job" && l.id === id);
    if (i < 0) return;
    // a note comment directly above goes with the job
    const prev = this.lines[i - 1];
    if (prev && prev.kind === "comment") this.lines.splice(i - 1, 2);
    else this.lines.splice(i, 1);
  }

  duplicate(id: number): void {
    const i = this.lines.findIndex((l) => l.kind === "job" && l.id === id);
    if (i < 0) return;
    const j = this.lines[i] as CronJob;
    this.lines.splice(i + 1, 0, newJob(j.schedule, j.command, j.enabled));
  }

  /** Adds (id = null) or updates a job. `comment` is the note line above it. */
  upsert(id: number | null, v: { schedule: string; command: string; enabled: boolean; comment: string }): void {
    if (id === null) {
      // keep new jobs after the last existing job (or at the end), with a blank separator when needed
      const jobIdx = this.jobs.at(-1)?.index ?? this.lines.length - 1;
      const at = jobIdx + 1;
      const j = newJob(v.schedule.trim(), v.command.trim(), v.enabled);
      this.lines.splice(at, 0, j);
      if (v.comment.trim()) setCommentAbove(this.lines, at, v.comment);
      return;
    }
    const i = this.lines.findIndex((l) => l.kind === "job" && l.id === id);
    if (i < 0) return;
    const j = this.lines[i] as CronJob;
    if (j.schedule !== v.schedule.trim() || j.command !== v.command.trim() || j.enabled !== v.enabled) {
      j.schedule = v.schedule.trim();
      j.command = v.command.trim();
      j.enabled = v.enabled;
      j.raw = null;
    }
    setCommentAbove(this.lines, i, v.comment);
  }

  /** Text of one job line as it would be written (for display). */
  lineText(j: CronJob): string {
    return j.raw ?? jobLine(j);
  }

  private find(id: number): CronJob | null {
    const l = this.lines.find((x) => x.kind === "job" && x.id === id);
    return (l as CronJob | undefined) ?? null;
  }

  async loadSystem(): Promise<void> {
    if (this.systemLoading) return;
    this.systemLoading = true;
    const out: SystemCron[] = [];
    const read = async (path: string) => {
      try {
        const f = await api.readFile(this.sessionId, path);
        out.push({ path, content: f.isBinary ? null : f.content, error: f.isBinary ? "binary file" : null });
      } catch (e) {
        out.push({ path, content: null, error: errMsg(e) });
      }
    };
    await read("/etc/crontab");
    try {
      const entries = await api.listDir(this.sessionId, "/etc/cron.d");
      // Cap: a host with hundreds of files in /etc/cron.d would otherwise read them all one by one.
      const files = entries.filter((e) => e.kind !== "dir" && !e.name.startsWith(".")).slice(0, 100);
      for (const e of files) await read(e.path);
    } catch {
      /* no /etc/cron.d */
    }
    this.system = out;
    this.systemLoading = false;
  }
}

class CronStore {
  bySession = $state<Record<string, CronSession>>({});

  ensure(sessionId: string): CronSession {
    let s = this.bySession[sessionId];
    if (!s) {
      s = new CronSession(sessionId);
      this.bySession[sessionId] = s;
    }
    return s;
  }
}

export const cronStore = new CronStore();
