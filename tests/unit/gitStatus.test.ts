import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeTree, groupStatus, parseStatus, treeFiles } from "../../src/lib/git/status";
import { friendlyGitError, parseRefs, parseStashes } from "../../src/lib/git/branches";

const Z = "\0";
const H = "1111111111111111111111111111111111111111";

test("parses branch headers", () => {
  const p = parseStatus(
    [`# branch.oid ${H}`, "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -3"].join(Z) + Z,
  );
  assert.equal(p.branch.oid, H);
  assert.equal(p.branch.head, "main");
  assert.equal(p.branch.upstream, "origin/main");
  assert.equal(p.branch.ahead, 2);
  assert.equal(p.branch.behind, 3);
  assert.equal(p.entries.length, 0);
});

test("initial and detached branches", () => {
  const a = parseStatus(`# branch.oid (initial)${Z}# branch.head main${Z}`);
  assert.equal(a.branch.oid, null);
  assert.equal(a.branch.upstream, null);
  const b = parseStatus(`# branch.oid ${H}${Z}# branch.head (detached)${Z}`);
  assert.equal(b.branch.head, null);
});

test("ordinary entries, staged and worktree", () => {
  const raw =
    `1 M. N... 100644 100644 100644 ${H} ${H} src/a.ts${Z}` +
    `1 .M N... 100644 100644 100644 ${H} ${H} src/b.ts${Z}` +
    `1 MM N... 100644 100644 100644 ${H} ${H} with space/c d.ts${Z}` +
    `1 A. N... 000000 100644 100644 ${"0".repeat(40)} ${H} new.txt${Z}` +
    `1 .D N... 100644 100644 000000 ${H} ${H} gone.txt${Z}`;
  const p = parseStatus(raw);
  assert.equal(p.entries.length, 5);
  assert.equal(p.entries[2].path, "with space/c d.ts");
  const g = groupStatus(p.entries);
  assert.deepEqual(
    g.staged.map((c) => `${c.code}:${c.path}`),
    ["M:src/a.ts", "A:new.txt", "M:with space/c d.ts"].sort((a, b) => a.slice(2).localeCompare(b.slice(2))),
  );
  assert.deepEqual(
    g.changes.map((c) => `${c.code}:${c.path}`),
    ["D:gone.txt", "M:src/b.ts", "M:with space/c d.ts"],
  );
  assert.ok(g.staged.every((c) => c.staged));
  assert.ok(g.changes.every((c) => !c.staged));
});

test("renames carry the original path (NUL separated)", () => {
  const raw = `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.ts${Z}old name.ts${Z}1 .M N... 100644 100644 100644 ${H} ${H} z.ts${Z}`;
  const p = parseStatus(raw);
  assert.equal(p.entries.length, 2);
  assert.equal(p.entries[0].kind, "rename");
  assert.equal(p.entries[0].path, "new name.ts");
  assert.equal(p.entries[0].origPath, "old name.ts");
  assert.equal(p.entries[1].path, "z.ts");
  const g = groupStatus(p.entries);
  assert.equal(g.staged[0].code, "R");
  assert.equal(g.staged[0].origPath, "old name.ts");
});

test("copies", () => {
  const p = parseStatus(`2 C. N... 100644 100644 100644 ${H} ${H} C75 copy.ts${Z}orig.ts${Z}`);
  assert.equal(p.entries[0].kind, "copy");
  assert.equal(groupStatus(p.entries).staged[0].code, "C");
});

test("unmerged entries go to the merge group", () => {
  const raw =
    `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.txt${Z}` +
    `u AA N... 000000 100644 100644 100644 ${H} ${H} ${H} both added.txt${Z}`;
  const p = parseStatus(raw);
  assert.equal(p.entries[0].kind, "unmerged");
  assert.equal(p.entries[1].path, "both added.txt");
  const g = groupStatus(p.entries);
  assert.equal(g.merge.length, 2);
  assert.equal(g.staged.length, 0);
  assert.equal(g.changes.length, 0);
  assert.equal(g.merge[0].code, "U");
  assert.equal(g.merge.find((c) => c.path === "both added.txt")?.conflictXY, "AA");
});

test("untracked files are listed last, ignored files dropped", () => {
  const raw = `? zzz.txt${Z}1 .M N... 100644 100644 100644 ${H} ${H} a.ts${Z}? dir/new file.txt${Z}! build/out.o${Z}`;
  const p = parseStatus(raw);
  const g = groupStatus(p.entries);
  assert.deepEqual(
    g.changes.map((c) => c.path),
    ["a.ts", "dir/new file.txt", "zzz.txt"],
  );
  assert.equal(g.changes[1].code, "?");
  assert.ok(g.changes[1].untracked);
  assert.equal(p.entries.filter((e) => e.kind === "ignored").length, 1);
});

test("submodules are flagged", () => {
  const p = parseStatus(`1 .M S.M. 160000 160000 160000 ${H} ${H} libs/sub${Z}`);
  assert.equal(p.entries[0].submodule, true);
  assert.equal(groupStatus(p.entries).changes[0].submodule, true);
});

test("empty and malformed input", () => {
  assert.deepEqual(parseStatus("").entries, []);
  assert.deepEqual(parseStatus(`1 M.${Z}garbage${Z}`).entries, []);
});

test("change tree compacts single-folder chains and sorts folders first", () => {
  const raw =
    `1 .M N... 1 1 1 ${H} ${H} a/b/c/one.ts${Z}` +
    `1 .M N... 1 1 1 ${H} ${H} a/b/c/two.ts${Z}` +
    `1 .M N... 1 1 1 ${H} ${H} root.ts${Z}` +
    `1 .M N... 1 1 1 ${H} ${H} src/x.ts${Z}` +
    `1 .M N... 1 1 1 ${H} ${H} src/lib/y.ts${Z}`;
  const g = groupStatus(parseStatus(raw).entries);
  const tree = buildChangeTree(g.changes);
  assert.deepEqual(
    tree.map((n) => n.name),
    ["a/b/c", "src", "root.ts"],
  );
  assert.equal(tree[0].children.length, 2);
  assert.equal(treeFiles(tree[1]).length, 2);
  assert.equal(tree[1].children[0].name, "lib");
});

test("parses refs", () => {
  const rec = (...f: string[]) => f.join("\0");
  const raw = [
    rec("refs/heads/main", "abc1234", "origin/main", "ahead 1, behind 2", "*", "Fix it"),
    rec("refs/heads/dev", "def5678", "", "", " ", "WIP"),
    rec("refs/heads/old", "0001111", "origin/old", "gone", " ", "x"),
    rec("refs/remotes/origin/main", "abc1234", "", "", " ", "Fix it"),
    rec("refs/remotes/origin/HEAD", "abc1234", "", "", " ", "Fix it"),
    rec("refs/remotes/origin/feat/x", "abc9999", "", "", " ", "feat"),
    rec("refs/tags/v1.2.0", "abc1234", "", "", " ", "rel"),
    rec("refs/tags/v1.10.0", "abc1234", "", "", " ", "rel"),
  ].join("\n");
  const r = parseRefs(raw);
  assert.deepEqual(
    r.local.map((b) => b.name),
    ["main", "dev", "old"],
  );
  assert.equal(r.local[0].current, true);
  assert.equal(r.local[0].ahead, 1);
  assert.equal(r.local[0].behind, 2);
  assert.equal(r.local[0].upstream, "origin/main");
  assert.equal(r.local[2].gone, true);
  assert.deepEqual(
    r.remote.map((b) => b.name),
    ["origin/feat/x", "origin/main"],
  );
  assert.equal(r.remote[0].remote, "origin");
  assert.equal(r.remote[0].short, "feat/x");
  assert.deepEqual(
    r.tags.map((t) => t.name),
    ["v1.10.0", "v1.2.0"],
  );
});

test("parses stashes", () => {
  const s = parseStashes("stash@{0}\0WIP on main: abc msg\0 2 hours ago\nstash@{1}\0On dev: x\0 3 days ago\n");
  assert.equal(s.length, 2);
  assert.equal(s[1].index, 1);
  assert.equal(s[0].message, "WIP on main: abc msg");
});

test("friendly errors", () => {
  assert.match(friendlyGitError("fatal: could not read Username for 'https://x': terminal prompts disabled"), /Authentication failed/);
  assert.match(friendlyGitError("Host key verification failed."), /Host key/);
  assert.equal(friendlyGitError("fatal: boom"), "fatal: boom");
});
