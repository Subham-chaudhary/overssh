// IPC contract (docs/GUIDE.md §5): every `call("cmd", {args})` in src/lib/api.ts must name a
// registered #[tauri::command] and pass exactly its parameters (camelCase); a parameter the
// frontend may leave out must be an Option on the Rust side. Catches drift between the two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RS = path.join(ROOT, "src-tauri/src");
const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

interface Param {
  name: string;
  optional: boolean;
}

function rustCommands(): Map<string, Param[]> {
  const out = new Map<string, Param[]>();
  for (const f of readdirSync(RS).filter((f) => f.endsWith(".rs"))) {
    const text = readFileSync(path.join(RS, f), "utf8");
    for (const m of text.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)\(([\s\S]*?)\)\s*(?:->|\{)/g)) {
      const params: Param[] = [];
      for (const p of m[2].split(/,(?![^<]*>)/)) {
        const mm = p.trim().match(/^(\w+)\s*:\s*([\s\S]+)$/);
        if (!mm) continue;
        const ty = mm[2].trim();
        if (/State<|AppHandle|WebviewWindow|\bWindow\b/.test(ty)) continue; // injected by Tauri
        params.push({ name: camel(mm[1]), optional: ty.startsWith("Option<") });
      }
      out.set(m[1], params);
    }
  }
  return out;
}

/** `call<T>("name", { a, b: x })` / `invoke('name', { ... })` sites, with the object keys. */
function frontendCalls(): { cmd: string; keys: string[]; where: string }[] {
  const files = [path.join(ROOT, "src/lib/api.ts"), path.join(ROOT, "src/lib/appIcon.ts")];
  const out: { cmd: string; keys: string[]; where: string }[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const re = /\b(?:call|invoke)(?:<[^()]*?>)?\(\s*["'](\w+)["'](?:\s*,\s*\{([^}]*)\})?/g;
    for (const m of text.matchAll(re)) {
      if (m[1].includes("|")) continue; // plugin:...
      const keys = (m[2] ?? "")
        .split(",")
        .map((s) => s.trim().split(":")[0].trim())
        .filter((k) => /^\w+$/.test(k));
      out.push({ cmd: m[1], keys, where: path.basename(file) });
    }
  }
  return out;
}

test("every Rust command is registered in generate_handler!", () => {
  const lib = readFileSync(path.join(RS, "lib.rs"), "utf8");
  const handler = lib.slice(lib.indexOf("generate_handler!["));
  for (const cmd of rustCommands().keys()) {
    assert.ok(new RegExp(`::${cmd}\\s*,`).test(handler), `${cmd} is not in generate_handler!`);
  }
});

test("every frontend call matches a Rust command's parameters", () => {
  const cmds = rustCommands();
  const calls = frontendCalls();
  assert.ok(calls.length > 50, `found only ${calls.length} calls: the parser is broken`);
  for (const { cmd, keys, where } of calls) {
    const params = cmds.get(cmd);
    assert.ok(params, `${where}: "${cmd}" has no #[tauri::command]`);
    const names = new Set(params.map((p) => p.name));
    for (const k of keys) assert.ok(names.has(k), `${where}: ${cmd} sends "${k}", which Rust does not take (has: ${[...names].join(", ")})`);
    for (const p of params) {
      if (!p.optional) assert.ok(keys.includes(p.name), `${where}: ${cmd} does not send required "${p.name}"`);
    }
  }
});
