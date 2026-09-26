// Filename -> human-readable language name for the status bar and for
// `Tab.language` (set synchronously when a tab is created, in
// stores.svelte.ts — before Monaco has necessarily loaded, since Monaco is
// lazy-loaded on first editor mount per docs/GUIDE.md §11). Monaco itself
// picks its own (richer) language id independently via
// `lib/monaco.ts#languageIdFor`, using `monaco.languages.getLanguages()`.

import { basename, extname } from "./paths";

function ext(filename: string): string {
  return extname(filename).toLowerCase();
}

function base(filename: string): string {
  return basename(filename).toLowerCase();
}

/** Human-readable language name for the status bar / `Tab.language`. */
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
