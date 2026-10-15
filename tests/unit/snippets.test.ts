import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVariables, isSecretName, parseTemplate, renderTemplate } from "../../src/components/snippets/template";

test("variables whose name suggests a secret are recognised", () => {
  for (const n of ["password", "DB_PASSWORD", "dbPassword", "passwd", "passphrase", "token", "API_KEY", "api-key", "apikey", "client_secret", "pass", "mysql.pwd", "aws_credentials"]) {
    assert.ok(isSecretName(n), n);
  }
  for (const n of ["host", "user", "bypass_count", "compass", "path", "branch", "name"]) {
    assert.ok(!isSecretName(n), n);
  }
});

test("templates: defaults, choices, escapes and broken braces", () => {
  const t = parseTemplate("ssh {{who:root}}@{{host}} \\{{literal}} {{env|dev|prod}} {{ {{oops");
  assert.deepEqual(extractVariables(t).map((v) => v.name), ["who", "env"]);
  assert.equal(renderTemplate(t, { who: "bob", env: "prod" }, { host: "h1" }), "ssh bob@h1 {{literal}} prod {{ {{oops");
  assert.equal(renderTemplate(parseTemplate("{{a}}{{b:x}}"), {}, {}), "x");
});
