import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLayoutRaw,
  captureProfile,
  duplicateProfile,
  hostForSession,
  mergeProfiles,
  moveItem,
  orderExpanded,
  planRestore,
  remapReferences,
  resolveHost,
  sanitizeFile,
  sanitizeProfile,
  uniqueName,
  type CaptureInput,
  type HostLite,
  type RestoreEnv,
} from "../../src/lib/profiles/model";
import { LIMITS, type WorkspaceProfile } from "../../src/lib/profiles/types";

const host = (key: string, name: string, hostname: string, over: Partial<HostLite> = {}): HostLite => ({
  key,
  source: key.startsWith("saved:") ? "saved" : "config",
  name,
  alias: key.startsWith("config:") ? name : null,
  hostname,
  user: "root",
  port: 22,
  identityFile: null,
  proxyJump: null,
  ...over,
});

const HOSTS: HostLite[] = [host("config:alpha", "alpha", "alpha.example.com"), host("saved:b1", "Beta box", "beta.example.com", { user: "deploy", port: 2222 })];

function session(id: string, label: string, hostname: string, user: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label,
    user,
    hostname,
    port: null as number | null,
    alias: null as string | null,
    workspace: {
      panes: [{ cwd: "/home/u", expanded: ["/home/u/a/b", "/home/u/a", "/home/u/z"] }],
      activePane: 0,
      splitRatio: 0.5,
      tabs: [
        { path: "/home/u/a.txt", line: 3, col: 4 },
        { path: "/home/u/b.txt", line: 1, col: 1 },
      ],
      activePath: "/home/u/b.txt",
    },
    ...over,
  };
}

function input(over: Partial<CaptureInput> = {}): CaptureInput {
  return {
    sessions: [
      session("s1", "alpha", "alpha.example.com", "root", { alias: "alpha" }),
      session("s2", "deploy@beta.example.com", "beta.example.com", "deploy", { port: 2222 }),
    ],
    hosts: HOSTS,
    terminals: [
      { id: "t1", key: "t1", sessionId: "s1", title: "Terminal 1", customTitle: false, cwd: "/srv" },
      { id: "t2", key: "t2", sessionId: "s1", title: "build", customTitle: true, cwd: null },
      { id: "t3", key: "t3", sessionId: "s2", title: "Terminal 1", customTitle: false, cwd: null },
    ],
    activeTerminalId: "t2",
    detached: false,
    layoutRaw: null,
    showTerminal: true,
    runningRules: [{ id: "r1", host: "config:alpha", label: "web", kind: "L", bindPort: 8080, targetHost: "localhost", targetPort: 80 }],
    activeSessionId: "s2",
    sidebarView: "explorer",
    dashboardTab: "htop",
    ...over,
  };
}

test("capture: hosts reference saved hosts, no secrets, order and active state kept", () => {
  const p = captureProfile(input(), { name: "Dev", now: 1000 });
  assert.equal(p.hosts.length, 2);
  assert.equal(p.hosts[0].ref.key, "config:alpha");
  assert.equal(p.hosts[1].ref.key, "saved:b1");
  assert.equal(p.activeHost, p.hosts[1].id);
  assert.deepEqual(p.hosts[0].explorer?.panes[0].expanded, ["/home/u/a", "/home/u/z", "/home/u/a/b"]); // parents first
  assert.deepEqual(p.hosts[0].files.map((f) => f.path), ["/home/u/a.txt", "/home/u/b.txt"]);
  assert.equal(p.hosts[0].files[0].line, 3);
  assert.equal(p.hosts[0].activeFile, "/home/u/b.txt");
  assert.equal(p.hosts[0].terminals.length, 2);
  assert.equal(p.hosts[0].terminals[0].title, null); // default titles are not captured
  assert.equal(p.hosts[0].terminals[1].title, "build");
  assert.equal(p.hosts[0].activeTerminal, 1);
  assert.deepEqual(p.hosts[0].forwards.map((f) => f.ruleId), ["r1"]);
  assert.equal(p.view.sidebar, "explorer");
  assert.equal(p.view.dashboardTab, "htop");
  const text = JSON.stringify(p);
  assert.ok(!/password|passphrase|secret/i.test(text));
});

test("capture: a session to the same host twice is saved once; unknown host becomes an ad-hoc reference", () => {
  const p = captureProfile(
    input({
      sessions: [
        session("s1", "alpha", "alpha.example.com", "root", { alias: "alpha" }),
        session("s9", "alpha", "alpha.example.com", "root", { alias: "alpha" }),
        session("s3", "me@quick.example.org", "quick.example.org", "me"),
      ],
    }),
    { name: "x" },
  );
  assert.equal(p.hosts.length, 2);
  assert.equal(p.hosts[1].ref.key, null);
  assert.equal(p.hosts[1].ref.hostname, "quick.example.org");
});

test("capture: sessionIds restricts hosts; running rules of an unconnected host become a tunnel-only entry", () => {
  const p = captureProfile(
    input({
      sessionIds: ["s2"],
      runningRules: [{ id: "r2", host: "config:alpha", label: "db", kind: "L", bindPort: 5432, targetHost: "db", targetPort: 5432 }],
    }),
    { name: "x" },
  );
  assert.equal(p.hosts.length, 2);
  assert.equal(p.hosts[0].ref.key, "saved:b1");
  assert.equal(p.hosts[1].tunnelOnly, true);
  assert.equal(p.hosts[1].forwards[0].ruleId, "r2");
  assert.equal(p.hosts[1].explorer, null);
});

test("update from current keeps id, name, look, entry ids and hand-typed startup commands", () => {
  const first = captureProfile(input(), { name: "Dev", icon: "rocket", color: "#61afef", now: 1 });
  first.hosts[0].terminals[0].command = "htop";
  const next = captureProfile(input(), { name: "ignored" }, first);
  assert.equal(next.id, first.id);
  assert.equal(next.icon, "rocket");
  assert.equal(next.hosts[0].id, first.hosts[0].id);
  assert.equal(next.hosts[0].terminals[0].command, "htop");
  assert.equal(next.createdAt, 1);
});

test("detached layout is mapped to profile terminals and rebuilt with fresh keys", () => {
  const layoutRaw = JSON.stringify({
    root: {
      type: "split",
      id: "n1",
      dir: "row",
      ratio: 0.3,
      a: { type: "leaf", id: "n2", key: "t1" },
      b: { type: "split", id: "n3", dir: "col", ratio: 0.6, a: { type: "leaf", id: "n4", key: "t2" }, b: { type: "leaf", id: "n5", key: "gone" } },
    },
    focusId: "n4",
  });
  const p = captureProfile(input({ detached: true, layoutRaw }), { name: "x" });
  assert.equal(p.terminals.detached, true);
  const layout = p.terminals.layout!;
  assert.equal(layout.type, "split");
  assert.deepEqual(p.terminals.focus, { entry: p.hosts[0].id, term: 1 });

  const e0 = p.hosts[0].id;
  const built = buildLayoutRaw(layout, p.terminals.focus, (entry, term) => (entry === e0 ? `new-${term}` : null))!;
  assert.equal(built.panes, 2);
  const state = JSON.parse(built.raw) as { root: { a: { key: string }; b: { key: string } }; focusId: string };
  assert.equal(state.root.a.key, "new-0");
  assert.equal(state.root.b.key, "new-1");
  // a terminal that failed to open drops its pane; fewer than two panes -> no layout
  assert.equal(buildLayoutRaw(layout, null, (entry, term) => (term === 0 ? "k" : null)), null);
});

test("sanitize: drops unknown keys, caps lists, rejects relative paths and bad colours", () => {
  const p = sanitizeProfile({
    name: "  Prod  ",
    color: "red",
    icon: "nope",
    password: "hunter2",
    hosts: [
      {
        ref: { hostname: "h", user: "u", port: 99999, password: "x", key: "saved:1" },
        explorer: { panes: [{ cwd: "relative", expanded: [] }, { cwd: "/ok", expanded: ["/ok/a", "bad", "/ok/a"] }] },
        files: [{ path: "/a" }, { path: "/a" }, { path: "rel" }, { path: "/b", line: -4, col: "x" }],
        activeFile: "/missing",
        terminals: Array.from({ length: 50 }, () => ({ cwd: "/t", command: "ls", extra: 1 })),
        activeTerminal: 3,
        forwards: [{ ruleId: "r", kind: "Z", bindPort: 8080 }, { ruleId: "r" }],
      },
      { ref: { hostname: "" } },
      "junk",
    ],
  })!;
  assert.equal(p.name, "Prod");
  assert.equal(p.color, null);
  assert.equal(p.icon, null);
  assert.equal(p.hosts.length, 1);
  const h = p.hosts[0];
  assert.equal(h.ref.port, 65535);
  assert.equal(JSON.stringify(p).includes("hunter2"), false);
  assert.equal(JSON.stringify(p).includes('"password"'), false);
  assert.equal(h.explorer!.panes.length, 1);
  assert.equal(h.explorer!.panes[0].cwd, "/ok");
  assert.deepEqual(h.explorer!.panes[0].expanded, ["/ok/a"]);
  assert.deepEqual(h.files.map((f) => f.path), ["/a", "/b"]);
  assert.equal(h.files[1].line, 1);
  assert.equal(h.activeFile, null);
  assert.equal(h.terminals.length, LIMITS.terminals);
  assert.equal(h.forwards.length, 1);
  assert.equal(h.forwards[0].kind, "L");
});

test("sanitizeFile: accepts the file or a bare array, repairs duplicate ids, validates the startup id", () => {
  const raw = [
    { id: "a", name: "A", hosts: [] },
    { id: "a", name: "B", hosts: [] },
    null,
  ];
  const f = sanitizeFile({ profiles: raw, startupId: "a", options: { mode: "parallel", closeOthers: 1 } });
  assert.equal(f.profiles.length, 2);
  assert.notEqual(f.profiles[0].id, f.profiles[1].id);
  assert.equal(f.startupId, "a");
  assert.equal(f.options.mode, "parallel");
  assert.equal(f.options.closeOthers, false);
  assert.equal(sanitizeFile(raw).profiles.length, 2);
  assert.equal(sanitizeFile("garbage").profiles.length, 0);
  assert.equal(sanitizeFile({ profiles: raw, startupId: "zzz" }).startupId, null);
});

test("very large profile is capped on load", () => {
  const big = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, hosts: [] }));
  assert.equal(sanitizeFile(big).profiles.length, LIMITS.profiles);
  const dirs = Array.from({ length: 5000 }, (_, i) => `/d/${i}`);
  assert.equal(orderExpanded(dirs).length, LIMITS.expanded);
});

test("host resolution: by key, by details after the id changed, ad-hoc, or gone", () => {
  const p = captureProfile(input(), { name: "x" });
  const alpha = p.hosts[0].ref;
  assert.equal(resolveHost(alpha, HOSTS)?.how, "key");
  // the saved host was deleted and re-created with a new id
  const beta = p.hosts[1].ref;
  const recreated = [HOSTS[0], host("saved:NEW", "Beta box", "beta.example.com", { user: "deploy", port: 2222 })];
  const r = resolveHost(beta, recreated);
  assert.equal(r?.how, "details");
  assert.equal(r?.host.key, "saved:NEW");
  // deleted for good
  assert.equal(resolveHost(beta, [HOSTS[0]]), null);
  // quick-connect reference (no key) is connected from its stored details
  const adhoc = { ...beta, key: null };
  assert.equal(resolveHost(adhoc, [HOSTS[0]])?.how, "adhoc");
});

test("hostForSession prefers the exact saved host", () => {
  const hosts = [host("config:web", "web", "web.example.com"), host("saved:w1", "Web (mine)", "web.example.com", { alias: "web" })];
  const h = hostForSession({ id: "s", label: "web", user: "root", hostname: "web.example.com", port: 22, alias: "web" }, hosts);
  assert.equal(h?.key, "saved:w1");
});

function env(over: Partial<RestoreEnv> = {}): RestoreEnv {
  return {
    hosts: HOSTS,
    rules: [{ id: "r1", host: "config:alpha", label: "web", kind: "L", bindPort: 8080, targetHost: "localhost", targetPort: 80 }],
    sessions: [],
    terminalCounts: {},
    ...over,
  };
}

test("plan: nothing connected -> everything opens; stale items are reported, not fatal", () => {
  const p = captureProfile(input(), { name: "x" });
  const plan = planRestore(p, env({ hosts: [HOSTS[0]], rules: [] }), { closeOthers: false });
  assert.equal(plan.items[0].skipReason, null);
  assert.equal(plan.items[0].openTerminals.length, 2);
  assert.equal(plan.items[0].forwards[0].ruleId, null);
  assert.match(plan.items[0].forwards[0].problem!, /no longer exists/);
  assert.match(plan.items[1].skipReason!, /no longer exists/);
});

test("plan: idempotent - connected host is reused and only missing terminals are opened", () => {
  const p = captureProfile(input(), { name: "x" });
  const plan = planRestore(
    p,
    env({ sessions: [{ id: "live", label: "alpha", user: "root", hostname: "alpha.example.com" }], terminalCounts: { live: 1 } }),
    { closeOthers: false },
  );
  assert.equal(plan.items[0].reuseSessionId, "live");
  assert.deepEqual(plan.items[0].openTerminals.map((t) => t.index), [1]);
  assert.equal(plan.items[1].reuseSessionId, null);
});

test("plan: close other workspaces keeps only sessions the profile uses", () => {
  const p = captureProfile(input(), { name: "x" });
  const plan = planRestore(
    p,
    env({
      sessions: [
        { id: "live", label: "alpha", user: "root", hostname: "alpha.example.com" },
        { id: "other", label: "gamma", user: "root", hostname: "gamma.example.com" },
      ],
    }),
    { closeOthers: true },
  );
  assert.deepEqual(plan.closeSessionIds, ["other"]);
  assert.deepEqual(planRestore(p, env({ sessions: [{ id: "other", label: "g", user: "r", hostname: "g" }] }), { closeOthers: false }).closeSessionIds, []);
});

test("plan: a rule whose id changed is found again by its shape", () => {
  const p = captureProfile(input(), { name: "x" });
  const plan = planRestore(
    p,
    env({ rules: [{ id: "NEW", host: "config:alpha", label: "web", kind: "L", bindPort: 8080, targetHost: "localhost", targetPort: 80 }] }),
    { closeOthers: false },
  );
  assert.equal(plan.items[0].forwards[0].ruleId, "NEW");
});

test("list operations: unique names, duplicate, move", () => {
  assert.equal(uniqueName("Dev", ["Dev", "dev 2"]), "Dev 3");
  assert.equal(uniqueName("  ", []), "Untitled profile");
  const p = captureProfile(input({ detached: true, layoutRaw: null }), { name: "Dev" });
  const d = duplicateProfile(p, "Dev copy");
  assert.notEqual(d.id, p.id);
  assert.notEqual(d.hosts[0].id, p.hosts[0].id);
  assert.equal(d.activeHost, d.hosts[1].id);
  assert.equal(d.lastOpenedAt, null);
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(moveItem(list, "c", -1).map((x) => x.id), ["a", "c", "b"]);
  assert.deepEqual(moveItem(list, "a", -5).map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual(moveItem(list, "zzz", 1).map((x) => x.id), ["a", "b", "c"]);
});

test("export / import: merge by id then name, remap references, nothing malformed gets in", () => {
  const a = captureProfile(input(), { name: "Dev", id: "p1" });
  const b: WorkspaceProfile = { ...captureProfile(input(), { name: "Ops", id: "p2" }) };
  const skip = mergeProfiles([a], [{ ...b, name: "dev", id: "other" }, b], "skip");
  assert.deepEqual([skip.added, skip.skipped], [1, 1]);
  const over = mergeProfiles([a], [{ ...b, name: "Dev", id: "other" }], "overwrite");
  assert.equal(over.profiles.length, 1);
  assert.equal(over.profiles[0].id, "p1");
  assert.equal(over.profiles[0].hosts.length, 2);
  const dup = mergeProfiles([a], [{ ...b, name: "Dev" }], "duplicate");
  assert.equal(dup.profiles[1].name, "Dev 2");

  const re = remapReferences([a], { hostKeys: { "saved:b1": "saved:zz" }, ruleIds: { r1: "r9" } });
  assert.equal(re[0].hosts[1].ref.key, "saved:zz");
  assert.equal(re[0].hosts[0].forwards[0].ruleId, "r9");
  assert.equal(a.hosts[1].ref.key, "saved:b1"); // input untouched
});

// --- settings sync section (docs/GUIDE.md §15.3.Y / §15.3.P) -------------------------------------

import { buildBundle, validateBundle } from "../../src/lib/sync/format";
import { computeImport, planImport } from "../../src/lib/sync/merge";
import type { SyncContext } from "../../src/lib/sync/types";

const syncCtx: SyncContext = { defaults: { theme: "one-dark", appearance: {} }, themeIds: ["one-dark"], htopColumns: [] };

test("sync: workspaceProfiles section is whitelisted, skipped when empty, and follows renamed hosts and rules", () => {
  const prof = captureProfile(input(), { name: "Dev", id: "p1" });
  const withSecret = JSON.parse(JSON.stringify(prof)) as Record<string, unknown>;
  withSecret.password = "hunter2";
  (withSecret.hosts as { ref: Record<string, unknown> }[])[0].ref.passphrase = "x";

  const empty = buildBundle({ workspaceProfiles: [] }, ["workspaceProfiles"], syncCtx, { app: "t" });
  assert.deepEqual(Object.keys(empty.sections), []);

  const bundle = buildBundle({ workspaceProfiles: [withSecret as never] }, ["workspaceProfiles"], syncCtx, { app: "t" });
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes("hunter2") && !text.includes("passphrase"));
  const v = validateBundle(text, syncCtx);
  assert.ok(v.ok);

  const bundleWithHosts = {
    ...bundle,
    sections: {
      ...bundle.sections,
      hosts: [{ id: "b1", name: "Beta box", alias: null, hostname: "beta.example.com", user: "deploy", port: 2222, identityFile: null, proxyJump: null, pinned: false, lastUsed: 1 }],
      forwards: [{ id: "r1", host: "config:alpha", kind: "L", bindAddress: "", bindPort: 8080, targetHost: "localhost", targetPort: 80, label: "web", autoStart: false, tunnelOnly: true }],
    },
  };
  // This machine already has a *different* host with that name and a rule with the same tunnel under another id.
  const current = {
    hosts: [{ id: "local-b", name: "Beta box", alias: null, hostname: "other", user: "x", port: 22, identityFile: null, proxyJump: null, pinned: false, lastUsed: 1 }],
    forwards: [{ id: "local-r", host: "config:alpha", kind: "L", bindAddress: "", bindPort: 8080, targetHost: "localhost", targetPort: 80, label: "mine", autoStart: false, tunnelOnly: true }],
  } as never;
  const res = computeImport(bundleWithHosts as never, ["hosts", "forwards", "workspaceProfiles"], current, { defaultResolution: "skip" });
  const merged = res.next.workspaceProfiles![0];
  assert.equal(merged.hosts[1].ref.key, "saved:local-b"); // the skipped host maps to the existing one
  assert.equal(merged.hosts[0].forwards[0].ruleId, "local-r"); // and the skipped rule to the existing rule

  const plan = planImport(bundleWithHosts as never, ["workspaceProfiles"], { workspaceProfiles: [prof] } as never);
  assert.equal(plan.previews[0].same, 1);
});
