// Production: icon id -> emitted asset URL for the Material Icon Theme SVGs
// (docs/GUIDE.md §14.4.X). `?no-inline` keeps them as real files in `dist`
// (never data URIs, no CDN, so `img-src 'self' data:` is satisfied); this
// module is a plain table of strings and is itself loaded lazily by
// `fileIcons.ts`. The browser fetches an SVG the first time a row shows it.
const modules = import.meta.glob("/node_modules/material-icon-theme/icons/*.svg", {
  eager: true,
  query: "?no-inline",
  import: "default",
}) as Record<string, string>;

const urls: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -4), url]),
);

export function iconUrl(id: string): string | undefined {
  return urls[id];
}
