// Pure snippet-template parsing/substitution (docs/GUIDE.md §13.4.N).
// No Svelte, no DOM, no app state: everything here is deterministic and easy
// to reason about.
//
// Syntax:
//   {{name}}              free-text variable
//   {{name:default}}      variable with a default (everything after the first ":")
//   {{name|a|b|c}}        choice variable (first option is the default)
//   {{host}} {{user}} {{cwd}} {{clipboard}} {{date}}   built-ins (never asked)
//   \{{                   literal "{{" (the backslash is dropped)
//
// A `{{` that does not form a valid placeholder (no closing `}}`, empty or
// invalid name) is kept as literal text, so shell snippets like `awk '{{x}}'`
// with odd content or `${{ }}` never throw.

export const BUILTINS = ["host", "user", "cwd", "clipboard", "date"] as const;
export type BuiltinName = (typeof BUILTINS)[number];

export type Token =
  | { kind: "text"; text: string }
  | { kind: "var"; name: string; default?: string; options?: string[]; builtin: boolean; raw: string };

export interface TemplateVar {
  name: string;
  default?: string;
  options?: string[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function isBuiltin(name: string): name is BuiltinName {
  return (BUILTINS as readonly string[]).includes(name);
}

/** Parses the inside of `{{ ... }}`. Returns null if it is not a valid placeholder. */
function parseInner(inner: string, raw: string): Token | null {
  const sep = inner.search(/[:|]/);
  const name = (sep === -1 ? inner : inner.slice(0, sep)).trim();
  if (!NAME_RE.test(name)) return null;
  const builtin = isBuiltin(name);
  if (sep === -1) return { kind: "var", name, builtin, raw };
  if (builtin) return { kind: "var", name, builtin, raw }; // built-ins ignore extras
  if (inner[sep] === ":") {
    return { kind: "var", name, default: inner.slice(sep + 1), builtin, raw };
  }
  const options = inner
    .slice(sep + 1)
    .split("|")
    .map((o) => o.trim())
    .filter((o, i, all) => o !== "" && all.indexOf(o) === i);
  if (options.length === 0) return { kind: "var", name, builtin, raw };
  return { kind: "var", name, options, default: options[0], builtin, raw };
}

export function parseTemplate(src: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("\\{{", i)) {
      text += "{{";
      i += 3;
      continue;
    }
    if (src.startsWith("{{", i)) {
      const end = src.indexOf("}}", i + 2);
      if (end !== -1) {
        const raw = src.slice(i, end + 2);
        const tok = parseInner(src.slice(i + 2, end), raw);
        if (tok) {
          flush();
          tokens.push(tok);
          i = end + 2;
          continue;
        }
      }
      text += "{{";
      i += 2;
      continue;
    }
    text += src[i];
    i += 1;
  }
  flush();
  return tokens;
}

/** Distinct user-facing variables in first-appearance order. A later use of
 * the same name can supply a default/options the first one lacked. */
export function extractVariables(tokens: Token[]): TemplateVar[] {
  const out: TemplateVar[] = [];
  for (const t of tokens) {
    if (t.kind !== "var" || t.builtin) continue;
    const existing = out.find((v) => v.name === t.name);
    if (!existing) {
      out.push({ name: t.name, default: t.default, options: t.options });
    } else {
      if (existing.default === undefined && t.default !== undefined) existing.default = t.default;
      if (!existing.options && t.options) existing.options = t.options;
    }
  }
  return out;
}

export function usedBuiltins(tokens: Token[]): BuiltinName[] {
  const out: BuiltinName[] = [];
  for (const t of tokens) {
    if (t.kind === "var" && t.builtin && !out.includes(t.name as BuiltinName)) out.push(t.name as BuiltinName);
  }
  return out;
}

export function initialValues(
  vars: TemplateVar[],
  remembered: Record<string, string> | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const v of vars) {
    const last = remembered?.[v.name];
    if (last !== undefined && (!v.options || v.options.includes(last))) values[v.name] = last;
    else values[v.name] = v.default ?? v.options?.[0] ?? "";
  }
  return values;
}

/** Substitutes values into the template. Unknown/missing variables fall back
 * to their default, else an empty string; missing built-ins stay empty. */
export function renderTemplate(
  tokens: Token[],
  values: Record<string, string>,
  builtins: Partial<Record<BuiltinName, string>>,
): string {
  let out = "";
  for (const t of tokens) {
    if (t.kind === "text") out += t.text;
    else if (t.builtin) out += builtins[t.name as BuiltinName] ?? "";
    else out += values[t.name] ?? t.default ?? "";
  }
  return out;
}

export function hasVariables(template: string): boolean {
  return extractVariables(parseTemplate(template)).length > 0;
}

/** Local date as YYYY-MM-DD. */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Variable names that look like they hold a secret ({{password}}, {{db_token}}, {{API_KEY}} ...).
 * Their values are not remembered with the snippet and a command that used one is not added to the
 * command history: both are written to disk in plain text (and the history can be exported).
 */
export function isSecretName(name: string): boolean {
  const n = name.toLowerCase();
  return /password|passwd|passphrase|secret|token|api[_.-]?key|credential|private[_.-]?key/.test(n) || /(^|[_.-])(pass|pwd)($|[_.-])/.test(n);
}
