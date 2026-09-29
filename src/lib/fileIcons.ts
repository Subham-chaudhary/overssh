// VS Code-like file type icons (docs/GUIDE.md §14.4.X), backed by the
// `material-icon-theme` package: its manifest maps file names, extensions and
// folder names to icon ids, and its SVGs are bundled by Vite (see
// `fileIconUrls.prod.ts`; dev serves them straight from node_modules). Everything is lazy-loaded: until `loadFileIcons()` has
// resolved, `fileIcon()` returns `null` and callers show a generic icon.

interface Manifest {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  light?: {
    fileNames?: Record<string, string>;
    fileExtensions?: Record<string, string>;
    folderNames?: Record<string, string>;
    folderNamesExpanded?: Record<string, string>;
  };
}

export interface FileIconResult {
  /** Material icon id, e.g. `typescript` or `folder-src-open`. */
  id: string;
  /** Asset URL of the SVG. */
  url: string;
}

let manifest: Manifest | null = null;
let urlOf: ((id: string) => string | undefined) | null = null;
let loading: Promise<void> | null = null;
const cache = new Map<string, FileIconResult | null>();

export function fileIconsReady(): boolean {
  return manifest !== null && urlOf !== null;
}

/** Loads the manifest and URL table once (safe to call repeatedly). */
export function loadFileIcons(): Promise<void> {
  loading ??= Promise.all([
    import("material-icon-theme/dist/material-icons.json"),
    import.meta.env.DEV ? import("./fileIconUrls.dev") : import("./fileIconUrls.prod"),
  ])
    .then(([m, u]) => {
      manifest = ((m as { default?: unknown }).default ?? m) as Manifest;
      urlOf = u.iconUrl;
    })
    .catch(() => {
      loading = null; // allow a retry; callers keep showing the fallback icon
    });
  return loading;
}

/** Candidate extensions for `a.test.ts`: `test.ts`, then `ts` (VS Code order). */
export function extensionCandidates(lowerName: string): string[] {
  const out: string[] = [];
  let i = lowerName.indexOf(".");
  while (i !== -1 && i < lowerName.length - 1) {
    out.push(lowerName.slice(i + 1));
    i = lowerName.indexOf(".", i + 1);
  }
  return out;
}

function pick(m: Manifest, light: boolean, isDir: boolean, isOpen: boolean, name: string): string {
  const lower = name.toLowerCase();
  const l = light ? m.light : undefined;
  if (isDir) {
    const key = isOpen ? "folderNamesExpanded" : "folderNames";
    const fallback = isOpen ? "folder-open" : "folder";
    return l?.[key]?.[lower] ?? m[key][lower] ?? fallback;
  }
  const byName = l?.fileNames?.[lower] ?? m.fileNames[lower];
  if (byName) return byName;
  for (const ext of extensionCandidates(lower)) {
    const hit = l?.fileExtensions?.[ext] ?? m.fileExtensions[ext];
    if (hit) return hit;
  }
  return "file";
}

/**
 * Icon for a file or folder name. `light` selects the light-theme variants
 * (`THEMES[settings.theme].isDark === false`). Returns `null` until the
 * manifest is loaded or when the SVG is missing.
 */
export function fileIcon(
  name: string,
  isDir: boolean,
  isOpen = false,
  light = false,
): FileIconResult | null {
  if (!manifest || !urlOf) return null;
  const key = `${light ? "l" : "d"}${isDir ? "d" : "f"}${isOpen ? "o" : "c"}${name}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let id = pick(manifest, light, isDir, isOpen, name);
  let url = urlOf(id);
  if (!url) {
    id = isDir ? (isOpen ? "folder-open" : "folder") : "file";
    url = urlOf(id);
  }
  const result = url ? { id, url } : null;
  cache.set(key, result);
  return result;
}
