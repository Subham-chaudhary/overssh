// Dev: Vite serves node_modules files by path, so each SVG is requested only when
// a row renders it. (Importing all of them as modules would be ~1250 requests.)
export function iconUrl(id: string): string | undefined {
  return `/node_modules/material-icon-theme/icons/${id}.svg`;
}
