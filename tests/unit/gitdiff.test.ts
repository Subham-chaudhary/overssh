import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeDiffSources,
  commitDiffSources,
  flattenTree,
  mergeChanges,
  nameStatusArgs,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainZ,
  totalStats,
  workingChanges,
  type FileChange,
} from "../../src/lib/git/diff";

test("name-status -z incl. renames and odd paths", () => {
  const ns = parseNameStatusZ("M\0src/a b.ts\0A\0new.txt\0R087\0old.ts\0moved/new.ts\0D\0gone.md\0");
  assert.deepEqual(
    ns.map((n) => [n.status, n.path, n.oldPath, n.similarity]),
    [
      ["M", "src/a b.ts", undefined, undefined],
      ["A", "new.txt", undefined, undefined],
      ["R", "moved/new.ts", "old.ts", 87],
      ["D", "gone.md", undefined, undefined],
    ],
  );
});

test("numstat -z merges onto name-status, binary and renames", () => {
  const ns = parseNameStatusZ("M\0a.ts\0R100\0old.ts\0new.ts\0M\0img.png\0");
  const st = parseNumstatZ("3\t1\ta.ts\0" + "0\t0\t\0old.ts\0new.ts\0" + "-\t-\timg.png\0");
  const ch = mergeChanges(ns, st);
  assert.equal(ch[0].added, 3);
  assert.equal(ch[0].deleted, 1);
  assert.equal(ch[1].path, "new.ts");
  assert.equal(ch[1].added, 0);
  assert.equal(ch[2].binary, true);
  assert.equal(ch[2].added, null);
  assert.deepEqual(totalStats(ch), { added: 3, deleted: 1 });
});

const f = (path: string): FileChange => ({ path, status: "M", added: 1, deleted: 0, binary: false });

test("flattenTree sorts dirs first, compacts chains, honours collapsed", () => {
  const rows = flattenTree([f("README.md"), f("src/lib/a.ts"), f("src/lib/b.ts"), f("src/app/x/y/z.ts"), f("docs/g.md")]);
  assert.deepEqual(
    rows.map((r) => `${r.depth}:${r.kind}:${r.name}`),
    [
      "0:dir:docs",
      "1:file:g.md",
      "0:dir:src",
      "1:dir:app/x/y",
      "2:file:z.ts",
      "1:dir:lib",
      "2:file:a.ts",
      "2:file:b.ts",
      "0:file:README.md",
    ],
  );
  const collapsed = flattenTree([f("src/lib/a.ts"), f("src/lib/b.ts"), f("src/c.ts")], new Set(["src/lib"]));
  assert.deepEqual(
    collapsed.map((r) => r.name),
    ["src", "lib", "c.ts"],
  );
});

test("diff sources for commits", () => {
  const sha = "b".repeat(40);
  const parent = "a".repeat(40);
  const mod = commitDiffSources(sha, parent, f("x/y.ts"));
  assert.deepEqual(mod.original, { kind: "git", spec: `${parent}:x/y.ts` });
  assert.deepEqual(mod.modified, { kind: "git", spec: `${sha}:x/y.ts` });
  const add = commitDiffSources(sha, parent, { ...f("n.ts"), status: "A" });
  assert.deepEqual(add.original, { kind: "empty" });
  const del = commitDiffSources(sha, parent, { ...f("n.ts"), status: "D" });
  assert.deepEqual(del.modified, { kind: "empty" });
  const ren = commitDiffSources(sha, parent, { ...f("new.ts"), status: "R", oldPath: "old.ts" });
  assert.deepEqual(ren.original, { kind: "git", spec: `${parent}:old.ts` });
  const root = commitDiffSources(sha, null, { ...f("n.ts"), status: "A" });
  assert.deepEqual(root.original, { kind: "empty" });
  assert.deepEqual(nameStatusArgs(sha, null).slice(-2), ["--root", sha]);
  assert.deepEqual(nameStatusArgs(sha, parent).slice(-2), [parent, sha]);
});

test("diff sources for working changes", () => {
  assert.deepEqual(changeDiffSources({ path: "p.ts", staged: true }).original, { kind: "git", spec: "HEAD:p.ts" });
  assert.deepEqual(changeDiffSources({ path: "p.ts", staged: true }).modified, { kind: "git", spec: ":p.ts" });
  const un = changeDiffSources({ path: "p.ts", staged: false });
  assert.deepEqual(un.original, { kind: "git", spec: ":p.ts" });
  assert.deepEqual(un.modified, { kind: "work", path: "p.ts" });
  assert.deepEqual(changeDiffSources({ path: "p.ts", staged: false, untracked: true }).original, { kind: "empty" });
});

test("porcelain -z parsing and staged/unstaged split", () => {
  const e = parsePorcelainZ("M  a.ts\0 M b.ts\0MM c.ts\0?? d.txt\0R  new.ts\0old.ts\0");
  assert.equal(e.length, 5);
  assert.equal(e[4].oldPath, "old.ts");
  const w = workingChanges(e);
  assert.deepEqual(
    w.map((x) => `${x.staged ? "S" : "W"}${x.letter}:${x.path}`),
    ["SM:a.ts", "WM:b.ts", "SM:c.ts", "WM:c.ts", "WU:d.txt", "SR:new.ts"],
  );
});
