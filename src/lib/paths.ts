// POSIX path helpers for remote paths. Never use Node's `path` module here —
// remote paths are always posix strings regardless of the host OS running OverSSH.

/** Join posix path segments, collapsing duplicate slashes and `.`/`..` where trivial. */
export function join(...parts: string[]): string {
  const filtered = parts.filter((p) => p !== "" && p !== undefined && p !== null);
  if (filtered.length === 0) return ".";
  const isAbsolute = filtered[0].startsWith("/");
  const segments: string[] = [];
  for (const part of filtered) {
    for (const seg of part.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (segments.length > 0 && segments[segments.length - 1] !== "..") {
          segments.pop();
        } else if (!isAbsolute) {
          segments.push("..");
        }
        continue;
      }
      segments.push(seg);
    }
  }
  const joined = segments.join("/");
  return isAbsolute ? "/" + joined : joined || ".";
}

/** Directory portion of a path, posix semantics (like `dirname(1)`). */
export function dirname(path: string): string {
  if (path === "") return ".";
  const isAbsolute = path.startsWith("/");
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return isAbsolute ? "/" : ".";
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

/** Final path segment, posix semantics (like `basename(1)`). */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return "/";
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Extension including the leading dot, or "" if none (dotfiles like `.bashrc` have no extension). */
export function extname(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return ""; // no dot, or dotfile with no further extension
  return base.slice(idx);
}

/** True if `path` is `/` or empty (nothing above it to navigate to). */
export function isRoot(path: string): boolean {
  return path === "/" || path === "";
}

/** Checks a file or folder name typed by the user (new file / folder, rename).
 * Returns an error message, or null when the name is fine. `allowSlash` lets
 * "a/b.txt" through (create in a sub folder); each segment is still checked. */
export function validateEntryName(raw: string, allowSlash = false): string | null {
  const name = raw.trim();
  if (name === "") return "Enter a name.";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "A name cannot contain control characters or line breaks.";
  if (!allowSlash && name.includes("/")) return "A name cannot contain '/'.";
  if (allowSlash && name.startsWith("/")) return "Enter a name, not an absolute path.";
  const segments = name.split("/").filter((s) => s !== "");
  if (segments.length === 0) return "Enter a name.";
  if (segments.some((s) => s === "." || s === "..")) return "'.' and '..' are not valid names.";
  if (segments.some((s) => s.length > 255)) return "A name can be at most 255 characters.";
  return null;
}
