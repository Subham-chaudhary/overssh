import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpuPercent,
  enabledGroup,
  filterRows,
  fmtCpu,
  fmtMem,
  fmtRelUsec,
  journalSpec,
  mergeRows,
  parseDeps,
  shortError,
  sortRows,
  splitUnit,
  stateCounts,
  templateOf,
  unescapeUnit,
  validUnit,
} from "../../src/lib/systemd/model";
import type { SvcRow, SystemdUnit, SystemdUnitFile } from "../../src/lib/systemd/types";

const u = (unit: string, active: string, sub: string, description = "", load = "loaded"): SystemdUnit => ({ unit, load, active, sub, description });
const f = (unit: string, state: string, preset: string | null = null): SystemdUnitFile => ({ unit, state, preset });

test("unit name validation mirrors the backend", () => {
  assert.ok(validUnit("nginx.service"));
  assert.ok(validUnit("foo@bar.service"));
  assert.ok(validUnit("dev-disk-by\\x2dlabel.device"));
  assert.ok(!validUnit(""));
  assert.ok(!validUnit("-x"));
  assert.ok(!validUnit("a b"));
  assert.ok(!validUnit("a;b"));
  assert.ok(!validUnit("$(id)"));
  assert.ok(!validUnit("a'b"));
  assert.ok(!validUnit("x".repeat(257)));
});

test("unescapeUnit decodes \\xNN", () => {
  assert.equal(unescapeUnit("dev-disk-by\\x2dlabel.device"), "dev-disk-by-label.device");
  assert.equal(unescapeUnit("plain.service"), "plain.service");
  assert.equal(unescapeUnit("a\\x20b.service"), "a b.service");
});

test("splitUnit / templateOf", () => {
  assert.deepEqual(splitUnit("foo@bar.service"), { base: "foo", instance: "bar", template: false, suffix: "service" });
  assert.deepEqual(splitUnit("foo@.service"), { base: "foo", instance: "", template: true, suffix: "service" });
  assert.deepEqual(splitUnit("nginx.service"), { base: "nginx", instance: "", template: false, suffix: "service" });
  assert.equal(templateOf("getty@tty1.service"), "getty@.service");
  assert.equal(templateOf("nginx.service"), null);
  assert.equal(templateOf("getty@.service"), null);
});

test("mergeRows: instances inherit template state, file-only units are added, templates are not", () => {
  const rows = mergeRows(
    [u("ssh.service", "active", "running", "OpenSSH"), u("getty@tty1.service", "active", "running")],
    [f("ssh.service", "enabled", "enabled"), f("getty@.service", "enabled"), f("cron.service", "disabled"), f("bad.service", "masked")],
  );
  const by = Object.fromEntries(rows.map((r) => [r.unit, r]));
  assert.equal(by["ssh.service"].enabled, "enabled");
  assert.equal(by["ssh.service"].preset, "enabled");
  assert.equal(by["getty@tty1.service"].enabled, "enabled");
  assert.equal(by["cron.service"].fileOnly, true);
  assert.equal(by["cron.service"].active, "inactive");
  assert.equal(by["bad.service"].load, "masked");
  assert.ok(!("getty@.service" in by));
  assert.equal(rows.length, 4);
});

const rows: SvcRow[] = mergeRows(
  [
    u("a.service", "active", "running", "Alpha daemon"),
    u("b.service", "failed", "failed", "Beta job"),
    u("c.service", "inactive", "dead", "Gamma"),
    u("d.service", "active", "exited", "Delta oneshot"),
    u("e.service", "activating", "start", "Epsilon"),
  ],
  [f("a.service", "enabled"), f("b.service", "enabled"), f("c.service", "disabled"), f("d.service", "static"), f("e.service", "masked")],
);

test("stateCounts and filters", () => {
  assert.deepEqual(stateCounts(rows), { all: 5, running: 1, failed: 1, inactive: 1 });
  const names = (o: Partial<Parameters<typeof filterRows>[1]>) =>
    filterRows(rows, { state: "all", enabled: "any", query: "", ...o }).map((r) => r.unit);
  assert.deepEqual(names({ state: "failed" }), ["b.service"]);
  assert.deepEqual(names({ state: "running" }), ["a.service"]);
  assert.deepEqual(names({ state: "inactive" }), ["c.service"]);
  assert.deepEqual(names({ enabled: "enabled" }), ["a.service", "b.service"]);
  assert.deepEqual(names({ enabled: "static" }), ["d.service"]);
  assert.deepEqual(names({ enabled: "masked" }), ["e.service"]);
  assert.deepEqual(names({ query: "alpha|gamma" }), ["a.service", "c.service"]);
  assert.deepEqual(names({ query: "B.SERV" }), ["b.service"]);
  assert.deepEqual(names({ state: "failed", query: "alpha" }), []);
});

test("enabledGroup", () => {
  assert.equal(enabledGroup("enabled-runtime"), "enabled");
  assert.equal(enabledGroup("indirect"), "static");
  assert.equal(enabledGroup("masked-runtime"), "masked");
  assert.equal(enabledGroup(""), "");
});

test("sortRows: state puts failed first; numeric sorts keep missing values last", () => {
  assert.deepEqual(sortRows(rows, "state", false).map((r) => r.unit), ["b.service", "e.service", "a.service", "d.service", "c.service"]);
  assert.deepEqual(sortRows(rows, "unit", true).map((r) => r.unit), ["e.service", "d.service", "c.service", "b.service", "a.service"]);
  const m = rows.map((r) => ({ ...r }));
  m[0].memory = 100;
  m[2].memory = 300;
  assert.deepEqual(sortRows(m, "memory", true).map((r) => r.unit).slice(0, 2), ["c.service", "a.service"]);
  assert.deepEqual(sortRows(m, "memory", false).map((r) => r.unit).slice(0, 2), ["a.service", "c.service"]);
  assert.equal(sortRows(m, "memory", false).at(-1)?.memory, null);
});

test("parseDeps handles unicode and ASCII trees", () => {
  const uni = "● nginx.service\n● ├─-.mount\n● ├─system.slice\n○ │ └─foo.service\n× └─sysinit.target\n●   ├─apparmor.service\n";
  const n = parseDeps(uni);
  assert.deepEqual(n[0], { name: "nginx.service", depth: 0, state: "active" });
  assert.deepEqual(n[1], { name: "-.mount", depth: 1, state: "active" });
  assert.deepEqual(n[3], { name: "foo.service", depth: 2, state: "inactive" });
  assert.deepEqual(n[4], { name: "sysinit.target", depth: 1, state: "failed" });
  assert.deepEqual(n[5], { name: "apparmor.service", depth: 2, state: "active" });
  const ascii = "nginx.service\n* |-system.slice\n* | `-foo.service\n* `-sysinit.target\n";
  const a = parseDeps(ascii);
  assert.deepEqual(a.map((x) => [x.name, x.depth]), [["nginx.service", 0], ["system.slice", 1], ["foo.service", 2], ["sysinit.target", 1]]);
  assert.deepEqual(parseDeps("No dependencies.\n"), []);
});

test("journalSpec: stock journal kind for system units, command for user / sudo", () => {
  assert.deepEqual(journalSpec("nginx.service", { user: false, sudo: false, lines: 300 }), { kind: "journal", unit: "nginx.service", lines: 300 });
  const s = journalSpec("nginx.service", { user: false, sudo: true, lines: 50 });
  assert.equal(s.kind, "command");
  assert.equal(s.command, "sudo -n journalctl -u 'nginx.service' -f -n 50 -o short-iso --no-pager");
  const us = journalSpec("foo@bar.service", { user: true, sudo: true, lines: 10 });
  assert.equal(us.command, "journalctl --user -u 'foo@bar.service' -f -n 10 -o short-iso --no-pager");
  assert.throws(() => journalSpec("x; rm -rf /", { user: false, sudo: false, lines: 1 }));
  assert.throws(() => journalSpec("-n", { user: true, sudo: false, lines: 1 }));
});

test("cpuPercent and formatting", () => {
  assert.equal(cpuPercent(0, 500_000_000, 1000), 50);
  assert.equal(cpuPercent(null, 5, 1000), null);
  assert.equal(cpuPercent(10, 5, 1000), null); // counter reset
  assert.equal(fmtMem(null), "");
  assert.equal(fmtMem(512), "512 B");
  assert.equal(fmtMem(1536), "1.5K");
  assert.equal(fmtMem(300 * 1024 * 1024), "300M");
  assert.equal(fmtCpu(0.01), "0.0");
  assert.equal(fmtCpu(12.34), "12.3");
  assert.equal(fmtRelUsec((1_000_000 + 90_000) * 1000, 1_000_000), "in 1m");
  assert.equal(fmtRelUsec(0 + 1000, 7_200_000), "2h ago");
});

test("shortError keeps the first lines", () => {
  assert.equal(shortError("a\n\n b \nc\nd"), "a · b · c");
  assert.ok(shortError("x".repeat(500)).length <= 300);
});
