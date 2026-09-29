import { test } from "node:test";
import assert from "node:assert/strict";
import { humanSize, modeOctal, modeString, ownerLabel, sizeWithBytes } from "../../src/lib/fileinfo";
import { extensionCandidates } from "../../src/lib/fileIcons";

test("modeString / modeOctal", () => {
  assert.equal(modeString(0o100644), "-rw-r--r--");
  assert.equal(modeString(0o040755), "drwxr-xr-x");
  assert.equal(modeString(0o120777), "lrwxrwxrwx");
  assert.equal(modeString(0o104755), "-rwsr-xr-x");
  assert.equal(modeString(0o101644), "-rw-r--r-T");
  assert.equal(modeString(0o041777), "drwxrwxrwt");
  assert.equal(modeOctal(0o100644), "0644");
  assert.equal(modeOctal(0o104755), "4755");
});

test("sizes and owners", () => {
  assert.equal(humanSize(512), "512 B");
  assert.equal(humanSize(1536), "1.5 KB");
  assert.equal(sizeWithBytes(1536), "1.5 KB (1,536 bytes)");
  assert.equal(ownerLabel("root", 0), "root (0)");
  assert.equal(ownerLabel(null, 1000), "1000");
  assert.equal(ownerLabel(null, null), "—");
});

test("icon extension candidates", () => {
  assert.deepEqual(extensionCandidates("app.test.ts"), ["test.ts", "ts"]);
  assert.deepEqual(extensionCandidates(".eslintrc.json"), ["eslintrc.json", "json"]);
  assert.deepEqual(extensionCandidates("makefile"), []);
});
