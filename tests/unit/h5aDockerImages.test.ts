import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImages } from "../../src/lib/docker/parse";
import { imageLabel } from "../../src/lib/docker/ui";

// An image pulled by digest is listed with Tag "<none>" and a real repository. `repo:<none>` is no
// valid reference for rmi / history / tag / run, so the commands must get the short id.
test("parseImages: a digest-pulled image gets the short id as ref, not repo:<none>", () => {
  const [img] = parseImages('{"ID":"sha256:abcdef1234567890","Repository":"nginx","Tag":"<none>","Size":"10MB"}');
  assert.equal(img.ref, "abcdef123456");
  assert.equal(img.dangling, false);
  assert.equal(img.repository, "nginx");
  assert.equal(imageLabel(img), "nginx@abcdef123456");
});

test("parseImages: tagged and dangling images keep their refs and labels", () => {
  const imgs = parseImages(
    ['{"ID":"a1a1a1a1a1a1","Repository":"localhost:5000/img","Tag":"v1"}', '{"ID":"b2b2b2b2b2b2","Repository":"<none>","Tag":"<none>"}'].join("\n"),
  );
  assert.equal(imgs[0].ref, "localhost:5000/img:v1");
  assert.equal(imageLabel(imgs[0]), "localhost:5000/img:v1");
  assert.equal(imgs[1].dangling, true);
  assert.equal(imageLabel(imgs[1]), "<none> b2b2b2b2b2b2");
});
