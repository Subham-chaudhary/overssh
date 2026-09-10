// Filename -> CodeMirror language extension, loaded lazily so the initial
// bundle stays small. Each branch is a separate dynamic import() so Vite can
// code-split per language.

import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { basename, extname } from "./paths";

function ext(filename: string): string {
  return extname(filename).toLowerCase();
}

function base(filename: string): string {
  return basename(filename).toLowerCase();
}

/** Human-readable language name for the status bar. Kept in sync with `languageFor`. */
export function languageName(filename: string): string {
  const e = ext(filename);
  const b = base(filename);

  if ([".js", ".jsx", ".mjs", ".cjs"].includes(e)) return "JavaScript";
  if ([".ts", ".tsx"].includes(e)) return "TypeScript";
  if (e === ".py") return "Python";
  if (e === ".rs") return "Rust";
  if (e === ".json" || e === ".jsonc") return "JSON";
  if (e === ".yaml" || e === ".yml") return "YAML";
  if (e === ".md") return "Markdown";
  if (e === ".html" || e === ".htm" || e === ".vue") return "HTML";
  if (e === ".css" || e === ".scss" || e === ".less") return "CSS";
  if (e === ".sql") return "SQL";
  if (e === ".go") return "Go";
  if (e === ".java") return "Java";
  if ([".c", ".h", ".cpp", ".hpp", ".cc"].includes(e)) return "C/C++";
  if (e === ".php") return "PHP";
  if (e === ".xml" || e === ".svg") return "XML";
  if ([".sh", ".bash", ".zsh"].includes(e) || [".bashrc", ".profile", ".zshrc"].includes(b))
    return "Shell";
  if (b === "dockerfile") return "Dockerfile";
  if (e === ".toml") return "TOML";
  if (b === "nginx.conf" || (b.endsWith(".conf") && b.includes("nginx"))) return "Nginx";
  if ([".ini", ".env", ".cfg", ".conf"].includes(e) || b === ".env") return "Properties";
  if (e === ".lua") return "Lua";
  if (e === ".rb") return "Ruby";
  if (e === ".pl" || e === ".pm") return "Perl";
  if (e === ".ps1" || e === ".psm1") return "PowerShell";
  if (b === "makefile") return "Makefile";
  return "Plain text";
}

/**
 * Resolve a filename to a CodeMirror language extension. Returns null for
 * plain text (no highlighting) or filenames we don't recognize.
 */
export async function languageFor(filename: string): Promise<Extension | null> {
  const e = ext(filename);
  const b = base(filename);

  if ([".js", ".jsx", ".mjs", ".cjs"].includes(e)) {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript();
  }
  if ([".ts", ".tsx"].includes(e)) {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ typescript: true, jsx: e === ".tsx" });
  }
  if (e === ".py") {
    const { python } = await import("@codemirror/lang-python");
    return python();
  }
  if (e === ".rs") {
    const { rust } = await import("@codemirror/lang-rust");
    return rust();
  }
  if (e === ".json" || e === ".jsonc") {
    const { json } = await import("@codemirror/lang-json");
    return json();
  }
  if (e === ".yaml" || e === ".yml") {
    const { yaml } = await import("@codemirror/lang-yaml");
    return yaml();
  }
  if (e === ".md") {
    const { markdown } = await import("@codemirror/lang-markdown");
    return markdown();
  }
  if (e === ".html" || e === ".htm" || e === ".vue") {
    const { html } = await import("@codemirror/lang-html");
    return html();
  }
  if (e === ".css" || e === ".scss" || e === ".less") {
    const { css } = await import("@codemirror/lang-css");
    return css();
  }
  if (e === ".sql") {
    const { sql } = await import("@codemirror/lang-sql");
    return sql();
  }
  if (e === ".go") {
    const { go } = await import("@codemirror/lang-go");
    return go();
  }
  if (e === ".java") {
    const { java } = await import("@codemirror/lang-java");
    return java();
  }
  if ([".c", ".h", ".cpp", ".hpp", ".cc"].includes(e)) {
    const { cpp } = await import("@codemirror/lang-cpp");
    return cpp();
  }
  if (e === ".php") {
    const { php } = await import("@codemirror/lang-php");
    return php();
  }
  if (e === ".xml" || e === ".svg") {
    const { xml } = await import("@codemirror/lang-xml");
    return xml();
  }
  if ([".sh", ".bash", ".zsh"].includes(e) || [".bashrc", ".profile", ".zshrc"].includes(b)) {
    const { shell } = await import("@codemirror/legacy-modes/mode/shell");
    return StreamLanguage.define(shell);
  }
  if (b === "dockerfile") {
    const { dockerFile } = await import("@codemirror/legacy-modes/mode/dockerfile");
    return StreamLanguage.define(dockerFile);
  }
  if (e === ".toml") {
    const { toml } = await import("@codemirror/legacy-modes/mode/toml");
    return StreamLanguage.define(toml);
  }
  if (b === "nginx.conf" || (b.endsWith(".conf") && b.includes("nginx"))) {
    const { nginx } = await import("@codemirror/legacy-modes/mode/nginx");
    return StreamLanguage.define(nginx);
  }
  if ([".ini", ".env", ".cfg", ".conf"].includes(e) || b === ".env") {
    const { properties } = await import("@codemirror/legacy-modes/mode/properties");
    return StreamLanguage.define(properties);
  }
  if (e === ".lua") {
    const { lua } = await import("@codemirror/legacy-modes/mode/lua");
    return StreamLanguage.define(lua);
  }
  if (e === ".rb") {
    const { ruby } = await import("@codemirror/legacy-modes/mode/ruby");
    return StreamLanguage.define(ruby);
  }
  if (e === ".pl" || e === ".pm") {
    const { perl } = await import("@codemirror/legacy-modes/mode/perl");
    return StreamLanguage.define(perl);
  }
  if (e === ".ps1" || e === ".psm1") {
    const { powerShell } = await import("@codemirror/legacy-modes/mode/powershell");
    return StreamLanguage.define(powerShell);
  }
  // Makefile has no legacy-modes mode bundled with this package set; skip.
  return null;
}
