import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLogArgs,
  formatRelative,
  isEmptyRepoError,
  matchesQuery,
  parseDetail,
  parseLog,
  parseRefList,
  parseRefs,
} from "../../src/lib/git/log";

const F = "\x1f";
const rec = (sha: string, parents: string, subject: string, refs = "", an = "Ann", ae = "a@x.io") =>
  [sha, parents, an, ae, "1700000000", "1700000100", subject, refs].join(F);

test("parseLog splits NUL records and fields", () => {
  const out =
    [
      rec("a".repeat(40), "b".repeat(40) + " " + "c".repeat(40), "Merge x", "HEAD -> main, origin/main, tag: v1"),
      rec("b".repeat(40), "", "Root | with, odd: chars"),
    ].join("\0") + "\0";
  const cs = parseLog(out, new Set(["origin/main"]));
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0].parents, ["b".repeat(40), "c".repeat(40)]);
  assert.equal(cs[0].authorDate, 1700000000);
  assert.equal(cs[0].committerDate, 1700000100);
  assert.deepEqual(cs[0].refs, [
    { kind: "branch", name: "main", current: true },
    { kind: "remote", name: "origin/main" },
    { kind: "tag", name: "v1" },
  ]);
  assert.deepEqual(cs[1].parents, []);
  assert.equal(cs[1].subject, "Root | with, odd: chars");
});

test("parseLog tolerates empty output and stray newlines", () => {
  assert.deepEqual(parseLog(""), []);
  assert.equal(parseLog("\n" + rec("a".repeat(40), "", "x") + "\0").length, 1);
});

test("parseRefs: detached HEAD, remote HEAD and stash are handled", () => {
  assert.deepEqual(parseRefs("HEAD, feature/x"), [
    { kind: "head", name: "HEAD", current: true },
    { kind: "branch", name: "feature/x" },
  ]);
  assert.deepEqual(parseRefs("origin/HEAD, refs/stash, origin/dev", new Set(["origin/dev", "origin/HEAD"])), [
    { kind: "remote", name: "origin/dev" },
  ]);
  assert.deepEqual(parseRefs(""), []);
});

test("buildLogArgs", () => {
  const all = buildLogArgs({ max: 500, all: true, showRemotes: true });
  assert.ok(all.includes("--topo-order") && all.includes("-z") && all.includes("--max-count=500"));
  assert.ok(all.indexOf("--exclude=refs/stash") < all.indexOf("--all"));
  assert.equal(all[all.length - 1], "--");
  const noRemote = buildLogArgs({ max: 10, all: true, showRemotes: false });
  assert.ok(!noRemote.includes("--all") && noRemote.includes("--branches") && noRemote.includes("HEAD"));
  assert.ok(buildLogArgs({ max: 10, all: false, showRemotes: true }).includes("HEAD"));
  assert.ok(buildLogArgs({ max: 10, all: true, showRemotes: true, ref: "refs/heads/dev" }).includes("refs/heads/dev"));
});

test("parseDetail keeps a multi-line message", () => {
  const out = [
    "a".repeat(40),
    "b".repeat(40),
    "Ann",
    "a@x",
    "1",
    "Bob",
    "b@x",
    "2",
    "HEAD -> main",
    "Subject\n\nBody line 1\nBody line 2\n",
  ].join(F);
  const d = parseDetail(out)!;
  assert.equal(d.committerName, "Bob");
  assert.equal(d.message, "Subject\n\nBody line 1\nBody line 2");
  assert.equal(d.refs[0].current, true);
  assert.equal(parseDetail("garbage"), null);
});

test("parseRefList", () => {
  const r = parseRefList("refs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/tags/v1\n");
  assert.deepEqual(
    r.map((x) => [x.kind, x.name]),
    [
      ["branch", "main"],
      ["remote", "origin/main"],
      ["tag", "v1"],
    ],
  );
});

test("empty repo error and search", () => {
  assert.ok(isEmptyRepoError("fatal: your current branch 'main' does not have any commits yet"));
  assert.ok(!isEmptyRepoError("fatal: bad object"));
  const c = parseLog(rec("abcdef0123456789".padEnd(40, "0"), "", "Fix the Parser", "tag: v2", "Zed Q", "zed@y.io") + "\0")[0];
  assert.ok(matchesQuery(c, "parser") && matchesQuery(c, "ZED") && matchesQuery(c, "abcdef0") && matchesQuery(c, "v2"));
  assert.ok(!matchesQuery(c, "nothing"));
  assert.ok(matchesQuery(c, "  "));
});

test("formatRelative", () => {
  const now = 1_700_000_000_000;
  const s = (d: number) => formatRelative(now / 1000 - d, now);
  assert.equal(s(10), "just now");
  assert.equal(s(60), "1 minute ago");
  assert.equal(s(3 * 3600), "3 hours ago");
  assert.equal(s(86400), "1 day ago");
  assert.equal(s(86400 * 14), "2 weeks ago");
  assert.equal(s(86400 * 60), "2 months ago");
  assert.equal(s(86400 * 800), "2 years ago");
});
