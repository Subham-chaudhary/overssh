// Sets the app version in package.json, src-tauri/Cargo.toml and
// src-tauri/tauri.conf.json. Usage: node scripts/set-version.mjs 1.2.13 (a leading "v" is ok).
import { readFileSync, writeFileSync } from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a semver version: "${process.argv[2] ?? ""}"`);
  process.exit(1);
}

function edit(path, fn) {
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before && !before.includes(version)) throw new Error(`no version field found in ${path}`);
  writeFileSync(path, after);
}

edit("package.json", (s) => s.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));
// Only the [package] version: the first `version = ` line in the file.
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]*"/m, `version = "${version}"`));
console.log(`version set to ${version}`);
