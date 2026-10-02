// Squarified treemap layout (Bruls, Huizing, van Wijk). Pure, no dependencies.
// docs/GUIDE.md §13.4.C.

export interface TmItem {
  id: string;
  value: number;
}

export interface TmRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  value: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Worst aspect ratio of a row of `areas` laid along a side of length `side`. */
function worst(areas: number[], side: number): number {
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

/**
 * Lays `items` out inside `box`. Items with value <= 0 are dropped. Areas are
 * proportional to values and exactly tile the box. Output keeps descending
 * value order.
 */
export function squarify(items: TmItem[], box: Box): TmRect[] {
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((s, i) => s + i.value, 0);
  if (!list.length || total <= 0 || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const areas = list.map((i) => i.value * scale);
  const out: TmRect[] = [];
  let { x, y, w, h } = box;

  let i = 0;
  while (i < list.length) {
    const side = Math.min(w, h);
    let end = i + 1;
    let row = [areas[i]];
    let cur = worst(row, side);
    while (end < list.length) {
      const next = [...row, areas[end]];
      const nw = worst(next, side);
      if (nw > cur) break;
      row = next;
      cur = nw;
      end++;
    }
    const sum = row.reduce((s, a) => s + a, 0);
    if (w >= h) {
      // lay the row as a column on the left
      const colW = sum / h;
      let cy = y;
      for (let k = 0; k < row.length; k++) {
        const rh = row[k] / colW;
        out.push({ id: list[i + k].id, x, y: cy, w: colW, h: rh, value: list[i + k].value });
        cy += rh;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = sum / w;
      let cx = x;
      for (let k = 0; k < row.length; k++) {
        const rw = row[k] / rowH;
        out.push({ id: list[i + k].id, x: cx, y, w: rw, h: rowH, value: list[i + k].value });
        cx += rw;
      }
      y += rowH;
      h -= rowH;
    }
    i = end;
  }
  return out;
}
