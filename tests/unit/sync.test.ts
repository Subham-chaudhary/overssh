import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBundle, countSection, sanitizeSection, stringifyBundle, validateBundle } from "../../src/lib/sync/format";
import { computeImport, diffLeaves, planImport } from "../../src/lib/sync/merge";
import { BUNDLE_FORMAT, BUNDLE_VERSION, type SyncContext, type SyncSections } from "../../src/lib/sync/types";

const ctx: SyncContext = {
  defaults: {
    theme: "one-dark",
    appearance: { accent: null, density: "normal", radius: "default", terminalAccent: true, motion: "full" },
    editor: { themeOverride: null, fontFamily: "Cascadia Code", fontSize: 13, minimap: true, cursorBlinking: "smooth" },
    files: { autoSave: "off", autoSaveDelay: 1000 },
    terminal: { fontSize: 13, recording: { enabled: false, directory: null } },
    docker: { command: "docker" },
  },
  themeIds: ["one-dark", "dracula", "nord"],
  htopColumns: ["pid", "user", "cpu", "mem", "command"],
};

const host = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  alias: null,
  hostname: `${name}.example.com`,
  user: "root",
  port: 22,
  identityFile: null,
  proxyJump: null,
  pinned: false,
  lastUsed: 5,
  ...extra,
});
const snippet = (id: string, name: string, cmd: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  cmd,
  tags: [],
  scope: "all",
  created: 1,
  lastUsed: 0,
  useCount: 0,
  ...extra,
});
const rule = (id: string, hostKey: string, extra: Record<string, unknown> = {}) => ({
  id,
  host: hostKey,
  kind: "L",
  bindAddress: "",
  bindPort: 8080,
  targetHost: "localhost",
  targetPort: 80,
  label: "web",
  autoStart: false,
  tunnelOnly: true,
  ...extra,
});

const live = (): SyncSections & Record<string, unknown> => ({
  settings: {
    theme: "dracula",
    appearance: { accent: "#ff0000" },
    editor: { fontSize: 15, fontFamily: "Fira", secretKey: "nope" },
    terminal: { fontSize: 12, recording: { enabled: true, directory: "C:\\Users\\me\\rec" } },
    unknownGroup: { a: 1 },
  },
  appearance: { theme: "dracula", appearance: { accent: "#FF0000", density: "compact" } },
  hosts: [host("h1", "alpha", { password: "hunter2", passphrase: "x", privateKey: "-----BEGIN" })] as never,
  snippets: [snippet("s1", "deploy", "make deploy", { lastValues: { TOKEN: "abc123" } })] as never,
  forwards: [rule("r1", "saved:h1")] as never,
  logs: {
    saved: [{ id: "l1", host: "root@alpha", name: "syslog", source: { kind: "file", path: "/var/log/syslog", password: "sudo-pw" } }],
    prefs: { maxLines: 5000 },
  } as never,
  prefs: { htop: { columns: ["pid", "cpu", "bogus", "command"], sortKey: "cpu", desc: true } },
  history: [{ cmd: "export TOKEN=abc", host: "root@alpha", count: 3, lastUsed: 9, pinned: false }],
});

const NOW = new Date("2026-01-02T03:04:05.000Z");
const ALL = ["settings", "appearance", "hosts", "snippets", "forwards", "logs", "prefs"] as const;

test("export contains the selected sections and no secrets", () => {
  const b = buildBundle(live(), ALL, ctx, { app: "0.1.0", now: NOW });
  assert.equal(b.format, BUNDLE_FORMAT);
  assert.equal(b.version, BUNDLE_VERSION);
  assert.equal(b.exportedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(Object.keys(b.sections).sort(), [...ALL].sort());
  const text = stringifyBundle(b);
  for (const secret of ["hunter2", "passphrase", "privateKey", "BEGIN", "abc123", "sudo-pw", "secretKey", "C:\\\\Users", "export TOKEN"]) {
    assert.equal(text.includes(secret), false, `leaked ${secret}`);
  }
  // theme/appearance live in their own section, machine paths stay home
  const settings = b.sections.settings as Record<string, any>;
  assert.equal("theme" in settings, false);
  assert.equal("appearance" in settings, false);
  assert.equal("directory" in settings.terminal.recording, false);
  assert.equal(settings.terminal.recording.enabled, true);
  assert.equal(settings.editor.fontSize, 15);
  assert.equal("unknownGroup" in settings, false);
  assert.deepEqual(b.sections.appearance, { theme: "dracula", appearance: { accent: "#ff0000", density: "compact" } });
  assert.deepEqual((b.sections.prefs as any).htop.columns, ["pid", "cpu", "command"]);
  assert.equal((b.sections.snippets as any)[0].lastValues, undefined);
  assert.equal((b.sections.logs as any).saved[0].source.password, undefined);
});

test("history is only exported when selected", () => {
  assert.equal("history" in buildBundle(live(), ALL, ctx, { app: "x" }).sections, false);
  const b = buildBundle(live(), ["history"], ctx, { app: "x" });
  assert.equal((b.sections.history as unknown[]).length, 1);
});

test("round trip: export then validate gives the same sections", () => {
  const b = buildBundle(live(), ALL, ctx, { app: "0.1.0", now: NOW });
  const v = validateBundle(stringifyBundle(b), ctx);
  assert.ok(v.ok);
  assert.deepEqual(v.bundle.sections, b.sections);
  assert.deepEqual(v.warnings, []);
});

test("validate rejects wrong format, bad json, bad version and empty bundles", () => {
  const bad = (x: unknown) => {
    const r = validateBundle(x, ctx);
    assert.equal(r.ok, false);
    return (r as { error: string }).error;
  };
  assert.match(bad("{not json"), /JSON/);
  assert.match(bad("[1]"), /OverSSH settings/);
  assert.match(bad({ format: "something-else", version: 1, sections: {} }), /wrong format/);
  assert.match(bad({ format: BUNDLE_FORMAT, version: "1", sections: {} }), /version/);
  assert.match(bad({ format: BUNDLE_FORMAT, version: 1.5, sections: {} }), /version/);
  assert.match(bad({ format: BUNDLE_FORMAT, version: 2, sections: { settings: { editor: { fontSize: 1 } } } }), /newer/);
  assert.match(bad({ format: BUNDLE_FORMAT, version: 1 }), /no sections/);
  assert.match(bad({ format: BUNDLE_FORMAT, version: 1, sections: { nothing: 1 } }), /nothing to import/);
  assert.match(bad("x".repeat(6 * 1024 * 1024)), /5 MB/);
});

test("validate ignores unknown keys and drops wrongly typed values", () => {
  const r = validateBundle(
    {
      format: BUNDLE_FORMAT,
      version: 1,
      futureField: true,
      sections: {
        settings: { editor: { fontSize: "huge", minimap: false, cursorBlinking: "wobble", extra: 1 }, files: { autoSave: "onFocusChange" }, bogus: {} },
        appearance: { theme: "not-a-theme", appearance: { accent: "red", density: "compact" } },
        hosts: [host("h1", "ok"), { id: "h2" }, "junk", host("h3", "bad-port", { port: 99999 })],
        weird: [],
      },
    },
    ctx,
  );
  assert.ok(r.ok);
  const s = r.bundle.sections;
  assert.deepEqual(s.settings, { editor: { minimap: false }, files: { autoSave: "onFocusChange" } });
  assert.deepEqual(s.appearance, { appearance: { density: "compact" } });
  assert.equal(s.hosts!.length, 2);
  assert.equal(s.hosts![1].port, 22);
  assert.ok(r.warnings.some((w) => w.includes("weird")));
  assert.ok(r.warnings.some((w) => w.includes("hosts")));
});

test("imported secrets in a hand-edited file are dropped", () => {
  const r = validateBundle(
    {
      format: BUNDLE_FORMAT,
      version: 1,
      sections: {
        hosts: [host("h1", "a", { password: "p", passphrase: "q" })],
        snippets: [snippet("s1", "n", "echo", { lastValues: { A: "secret" } })],
        logs: { saved: [{ id: "l", host: "h", name: "n", source: { kind: "file", path: "/x", password: "pw" } }], prefs: {} },
      },
    },
    ctx,
  );
  assert.ok(r.ok);
  const text = JSON.stringify(r.bundle);
  assert.equal(/password|passphrase|secret|"pw"/.test(text), false);
});

test("settings diff counts changed leaves only", () => {
  const d = diffLeaves({ editor: { fontSize: 13, minimap: true } }, { editor: { fontSize: 13, minimap: false } });
  assert.deepEqual(d, [{ path: "editor.minimap", from: true, to: false }]);
});

const bundleOf = (sections: Record<string, unknown>) => {
  const r = validateBundle({ format: BUNDLE_FORMAT, version: 1, exportedAt: NOW.toISOString(), app: "t", sections }, ctx);
  assert.ok(r.ok);
  return r.bundle;
};

test("hosts: new, identical and conflicting entries are classified", () => {
  const current: SyncSections = { hosts: [host("h1", "alpha"), host("h2", "beta")] as never };
  const bundle = bundleOf({
    hosts: [
      host("h1", "alpha"), // identical
      host("h2", "beta", { port: 2222 }), // same id, different
      host("h9", "ALPHA", { hostname: "other" }), // same name, different id
      host("h4", "delta"), // new
    ],
  });
  const plan = planImport(bundle, ["hosts"], current);
  const p = plan.previews[0];
  assert.equal(p.incoming, 4);
  assert.equal(p.same, 1);
  assert.equal(p.add, 1);
  assert.equal(p.conflicts, 2);
  assert.deepEqual(plan.conflicts.map((c) => [c.key, c.reason]), [["hosts:h2", "id"], ["hosts:h9", "name"]]);
});

test("hosts: skip / overwrite / keep both", () => {
  const current: SyncSections = { hosts: [host("h1", "alpha"), host("h2", "beta")] as never };
  const bundle = bundleOf({ hosts: [host("h2", "beta", { port: 2222 }), host("h9", "alpha", { hostname: "other.example.com" })] });
  let n = 0;
  const newId = () => `new${++n}`;

  const skip = computeImport(bundle, ["hosts"], current, { defaultResolution: "skip", newId });
  assert.deepEqual(skip.next.hosts, current.hosts);

  const over = computeImport(bundle, ["hosts"], current, { defaultResolution: "overwrite", newId });
  const byId = Object.fromEntries(over.next.hosts!.map((h) => [h.id, h]));
  assert.equal(over.next.hosts!.length, 2);
  assert.equal(byId.h2.port, 2222);
  assert.equal(byId.h1.hostname, "other.example.com"); // name match: keeps the existing id h1
  assert.equal(byId.h9, undefined);

  const both = computeImport(bundle, ["hosts"], current, { defaultResolution: "keepBoth", newId });
  assert.equal(both.next.hosts!.length, 4);
  const ids = both.next.hosts!.map((h) => h.id);
  assert.equal(new Set(ids).size, 4);
  assert.ok(both.next.hosts!.some((h) => h.id === "h9" && h.name === "alpha (imported)"));
  assert.ok(both.next.hosts!.some((h) => h.id === "new1" && h.port === 2222));

  const mixed = computeImport(bundle, ["hosts"], current, { decisions: { "hosts:h2": "overwrite" }, defaultResolution: "skip", newId });
  assert.equal(mixed.next.hosts!.find((h) => h.id === "h2")!.port, 2222);
  assert.equal(mixed.next.hosts!.length, 2);
});

test("forwards follow their host when it is imported under a new id", () => {
  const current: SyncSections = { hosts: [host("h1", "alpha")] as never, forwards: [] };
  const bundle = bundleOf({
    hosts: [host("h1", "alpha", { port: 2200 })],
    forwards: [rule("r1", "saved:h1")],
  });
  const res = computeImport(bundle, ["hosts", "forwards"], current, { defaultResolution: "keepBoth", newId: () => "fresh" });
  assert.equal(res.next.hosts!.length, 2);
  assert.equal(res.next.forwards![0].host, "saved:fresh");

  const skipped = computeImport(bundle, ["hosts", "forwards"], { hosts: [host("h5", "alpha")] as never }, { defaultResolution: "skip" });
  assert.equal(skipped.next.forwards![0].host, "saved:h5"); // skipped host -> existing one by name
});

test("forwards: same tunnel with another id is a conflict, plan flags unknown hosts", () => {
  const current: SyncSections = { forwards: [rule("r1", "saved:h1")] as never, hosts: [host("h1", "alpha")] as never };
  const bundle = bundleOf({ forwards: [rule("rX", "saved:h1", { label: "renamed" }), rule("rY", "saved:ghost", { bindPort: 9000 })] });
  const plan = planImport(bundle, ["forwards"], current);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "tunnel");
  assert.equal(plan.previews[0].add, 1);
  assert.match(plan.previews[0].note ?? "", /not found/);
  const both = computeImport(bundle, ["forwards"], current, { defaultResolution: "keepBoth", newId: () => "n1" });
  assert.equal(both.next.forwards!.length, 3);
  assert.equal(both.next.forwards!.find((r) => r.id === "rX")!.autoStart, false);
});

test("snippets conflict by id and by name", () => {
  const current: SyncSections = { snippets: [snippet("s1", "deploy", "make deploy"), snippet("s2", "logs", "tail -f x")] as never };
  const bundle = bundleOf({
    snippets: [snippet("s1", "deploy", "make deploy"), snippet("s3", "Logs", "journalctl -f"), snippet("s4", "new", "ls")],
  });
  const plan = planImport(bundle, ["snippets"], current);
  assert.equal(plan.previews[0].same, 1);
  assert.equal(plan.previews[0].add, 1);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "name");
  const res = computeImport(bundle, ["snippets"], current, { defaultResolution: "overwrite" });
  assert.equal(res.next.snippets!.find((s) => s.id === "s2")!.cmd, "journalctl -f");
});

test("settings, appearance and prefs come back as patches; history merges", () => {
  const current: SyncSections = {
    settings: { editor: { fontSize: 13, minimap: true } },
    appearance: { theme: "one-dark", appearance: { density: "normal" } },
    history: [{ cmd: "ls", host: "a", count: 2, lastUsed: 5, pinned: false }],
  };
  const bundle = bundleOf({
    settings: { editor: { fontSize: 18 } },
    appearance: { theme: "nord" },
    history: [
      { cmd: "ls", host: "a", count: 5, lastUsed: 1, pinned: true },
      { cmd: "pwd", host: "a", count: 1, lastUsed: 2, pinned: false },
    ],
  });
  const plan = planImport(bundle, ["settings", "appearance", "history"], current);
  assert.deepEqual(plan.previews.map((p) => [p.id, p.changes.length]), [["settings", 1], ["appearance", 1], ["history", 0]]);
  assert.equal(plan.previews[2].add, 1);
  const res = computeImport(bundle, ["settings", "appearance", "history"], current);
  assert.deepEqual(res.next.settings, { editor: { fontSize: 18 } });
  assert.deepEqual(res.next.appearance, { theme: "nord" });
  const ls = res.next.history!.find((e) => e.cmd === "ls")!;
  assert.deepEqual([ls.count, ls.lastUsed, ls.pinned], [5, 5, true]);
  assert.equal(res.next.history!.length, 2);
});

test("only selected sections are imported", () => {
  const bundle = bundleOf({ settings: { editor: { fontSize: 18 } }, hosts: [host("h1", "a")] });
  const res = computeImport(bundle, ["hosts"], {});
  assert.deepEqual(Object.keys(res.next), ["hosts"]);
});

test("countSection and sanitizeSection basics", () => {
  const b = buildBundle(live(), ALL, ctx, { app: "x" });
  assert.equal(countSection("hosts", b.sections), 1);
  assert.equal(countSection("logs", b.sections), 2);
  assert.equal(sanitizeSection("hosts", "nope", ctx), null);
  assert.equal(sanitizeSection("settings", [], ctx), null);
});
