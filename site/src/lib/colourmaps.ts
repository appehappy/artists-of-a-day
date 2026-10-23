// Colour maps made of artworks: shapes, colour maths and matching.
//
// A shape is a set of grid slots, each with t (0→1 along the gradient) and v (0→1
// across the shape, used for a gentle light-to-dark shift). Matching picks works so
// every stretch of the gradient gets its fair share of the closest-matching works,
// then lines them up with the slots by fine gradient position and lightness.
// Data comes from scripts/build_colourmaps.py.

export interface ColourMap { name: string; type: string; stops: string[] }

export interface Slots {
  n: number;
  x: Int32Array;
  y: Int32Array;
  t: Float32Array;
  v: Float32Array;
  /** Typical number of slots across the shape at one point of the gradient. */
  thickness: number;
}

export interface Match {
  rows: Int32Array; // artwork row for each slot
  slotRgb: Float32Array; // target colour (sRGB 0–1) per slot, for the zoom tint
  distance: number; // mean OKLab distance between works and their slot colour
}

// ── colour ──────────────────────────────────────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Colour of a map at t, interpolating its stops in sRGB. */
export function sampleRgb(map: ColourMap, t: number): [number, number, number] {
  const p = Math.min(1, Math.max(0, t)) * (map.stops.length - 1);
  const i = Math.min(map.stops.length - 2, Math.floor(p));
  const f = p - i;
  const a = hexToRgb(map.stops[i]);
  const b = hexToRgb(map.stops[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export const cssGradient = (map: ColourMap) =>
  `linear-gradient(90deg, ${map.stops.filter((_, i) => i % 4 === 0 || i === map.stops.length - 1).join(", ")})`;

// ── shapes ──────────────────────────────────────────────────────────────────

export const SHAPES = [
  { key: "band", label: "Band", suits: "Sequential" },
  { key: "ring", label: "Ring", suits: "Cyclic" },
  { key: "bowtie", label: "Bow-tie", suits: "Diverging" },
  { key: "steps", label: "Steps", suits: "Multi-sequential" },
] as const;
export type ShapeKey = (typeof SHAPES)[number]["key"];

function slots(cells: { x: number; y: number; t: number; v: number }[], thickness: number): Slots {
  const n = cells.length;
  const s: Slots = { n, x: new Int32Array(n), y: new Int32Array(n), t: new Float32Array(n),
                     v: new Float32Array(n), thickness: Math.max(1, Math.round(thickness)) };
  cells.forEach((c, i) => { s.x[i] = c.x; s.y[i] = c.y; s.t[i] = c.t; s.v[i] = c.v; });
  return s;
}

/** Cells of a polar shape: all grid cells passing `keep`, nearest the centre first. */
function polarCells(radius: number, keep: (r: number, a: number) => boolean) {
  const size = Math.ceil(radius) * 2 + 4;
  const out: { x: number; y: number; r: number; a: number }[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - size / 2, dy = y + 0.5 - size / 2;
      const r = Math.hypot(dx, dy);
      const a = ((Math.atan2(dx, -dy) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); // 0 = up, clockwise
      if (keep(r, a)) out.push({ x, y, r, a });
    }
  }
  return out;
}

export function makeShape(shape: ShapeKey, n: number): Slots {
  switch (shape) {
    case "band": {
      const h = Math.max(4, Math.round(Math.sqrt(n / 6)));
      const w = Math.ceil(n / h);
      const cells = [];
      for (let i = 0; i < n; i++) {
        const x = Math.floor(i / h), y = i % h;
        cells.push({ x, y, t: (x + 0.5) / w, v: (y + 0.5) / h });
      }
      return slots(cells, h);
    }
    case "ring": {
      const hole = 0.5;
      const R = Math.sqrt(n / (Math.PI * (1 - hole * hole))) + 1;
      const mid = (R * (1 + hole)) / 2;
      const all = polarCells(R + 1, (r) => r >= hole * R - 1 && r <= R + 1)
        .sort((p, q) => Math.abs(p.r - mid) - Math.abs(q.r - mid)).slice(0, n);
      const rs = all.map((c) => c.r);
      const r0 = Math.min(...rs), r1 = Math.max(...rs);
      return slots(all.map((c) => ({ x: c.x, y: c.y, t: c.a / (2 * Math.PI), v: (c.r - r0) / (r1 - r0) })),
                   R * (1 - hole));
    }
    case "bowtie": {
      const aspect = 3.2, waist = 0.22;
      let H = Math.sqrt(n / ((aspect * (1 + waist)) / 2));
      const W = Math.round(H * aspect);
      H = Math.round(H) + 2;
      const cells = [];
      for (let x = 0; x < W; x++) {
        const u = ((x + 0.5) / W) * 2 - 1;
        const h = Math.round(H * (waist + (1 - waist) * Math.abs(u)));
        const top = Math.round((H - h) / 2);
        for (let y = top; y < top + h; y++) cells.push({ x, y, t: (x + 0.5) / W, v: (y - top + 0.5) / h });
      }
      return slots(cells, (H * (1 + waist)) / 2);
    }
    case "steps": {
      // Nine separate blocks: a discrete palette, each block a slice of the gradient.
      const k = 9;
      const per = Math.ceil(n / k);
      const side = Math.ceil(Math.sqrt(per));
      const gap = Math.max(2, Math.round(side * 0.18));
      const cells = [];
      for (let i = 0; i < n; i++) {
        const b = Math.floor(i / per), j = i % per;
        const col = Math.floor(j / side), row = j % side;
        cells.push({ x: b * (side + gap) + col, y: row, t: (b + (col + 0.5) / side) / k, v: (row + 0.5) / side });
      }
      return slots(cells, side);
    }
  }
}

// ── matching ────────────────────────────────────────────────────────────────

const BINS = 128;

/** The k unused items with the smallest distance, via a bounded max-heap. */
function closest(k: number, count: number, used: Uint8Array, distance: (i: number) => number): number[] {
  if (k <= 0) return [];
  const heapD = new Float64Array(k);
  const heapI = new Int32Array(k);
  let size = 0;
  const swap = (a: number, b: number) => {
    [heapD[a], heapD[b]] = [heapD[b], heapD[a]];
    [heapI[a], heapI[b]] = [heapI[b], heapI[a]];
  };
  for (let i = 0; i < count; i++) {
    if (used[i]) continue;
    const d = distance(i);
    if (size < k) {
      let c = size++;
      heapD[c] = d; heapI[c] = i;
      while (c > 0 && heapD[(c - 1) >> 1] < heapD[c]) { swap(c, (c - 1) >> 1); c = (c - 1) >> 1; }
    } else if (d < heapD[0]) {
      heapD[0] = d; heapI[0] = i;
      for (let c = 0; ;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < k && heapD[l] > heapD[m]) m = l;
        if (r < k && heapD[r] > heapD[m]) m = r;
        if (m === c) break;
        swap(c, m);
        c = m;
      }
    }
  }
  return Array.from(heapI.subarray(0, size));
}

/** Pick works for `s` and assign them to slots. `lab` is OKLab per artwork (n×3). */
export function match(lab: Float32Array, map: ColourMap, s: Slots): Match {
  const count = lab.length / 3;
  const stops = Array.from({ length: BINS }, (_, b) => rgbToOklab(sampleRgb(map, (b + 0.5) / BINS)));

  // Each work's nearest bin, distance, and fine position along the gradient.
  const near = new Int32Array(count);
  const dist = new Float32Array(count);
  const fine = new Float32Array(count);
  const d = new Float32Array(BINS);
  for (let i = 0; i < count; i++) {
    const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
    let best = 0;
    for (let b = 0; b < BINS; b++) {
      const st = stops[b];
      d[b] = Math.hypot(L - st[0], A - st[1], B - st[2]);
      if (d[b] < d[best]) best = b;
    }
    near[i] = best;
    dist[i] = d[best];
    // Refine between neighbouring bins by comparing distances to them.
    const lo = best > 0 ? d[best - 1] : Infinity, hi = best < BINS - 1 ? d[best + 1] : Infinity;
    const shift = lo === Infinity && hi === Infinity ? 0 : (lo - hi) / (2 * Math.max(1e-6, lo + hi - 2 * d[best]));
    fine[i] = (best + 0.5 + Math.max(-0.5, Math.min(0.5, shift))) / BINS;
  }

  // Each bin needs as many works as the shape has slots at that point of the
  // gradient (a bow-tie's wide ends need more than its waist).
  // Bins with the fewest close works choose first, each taking the closest
  // still-unused works to its colour from the whole archive.
  const quota = new Int32Array(BINS);
  for (let i = 0; i < s.n; i++) quota[Math.min(BINS - 1, Math.floor(s.t[i] * BINS))]++;
  const close = new Int32Array(BINS);
  const sortedDist = Float32Array.from(dist).sort();
  const radius = sortedDist[Math.floor(count * 0.3)]; // "close" = within the best 30% of fits
  for (let i = 0; i < count; i++) if (dist[i] < radius) close[near[i]]++;
  const order = [...Array(BINS).keys()].sort((p, q) => close[p] / (quota[p] || 1) - close[q] / (quota[q] || 1));
  const used = new Uint8Array(count);
  const chosen: { row: number; bin: number }[] = [];
  for (const b of order) {
    const [sl, sa, sb] = stops[b];
    for (const row of closest(quota[b], count, used, (i) =>
      Math.hypot(lab[i * 3] - sl, lab[i * 3 + 1] - sa, lab[i * 3 + 2] - sb))) {
      used[row] = 1;
      chosen.push({ row, bin: b });
    }
  }

  // Line works up with slots: both in gradient order, then within each cross-section
  // of the shape, lighter works to the lighter side (v = 0).
  chosen.sort((p, q) => p.bin - q.bin || fine[p.row] - fine[q.row]);
  const slotOrder = [...Array(s.n).keys()].sort((p, q) => s.t[p] - s.t[q]);
  const rows = new Int32Array(s.n);
  const g = s.thickness;
  for (let i0 = 0; i0 < s.n; i0 += g) {
    const sl = slotOrder.slice(i0, i0 + g).sort((p, q) => s.v[p] - s.v[q]);
    const wk = chosen.slice(i0, i0 + g).map((c) => c.row).sort((p, q) => lab[q * 3] - lab[p * 3]);
    sl.forEach((slot, j) => { rows[slot] = wk[j]; });
  }

  const slotRgb = new Float32Array(s.n * 3);
  let total = 0;
  for (let i = 0; i < s.n; i++) {
    const rgb = sampleRgb(map, s.t[i]);
    slotRgb.set(rgb, i * 3);
    const st = rgbToOklab(rgb);
    const r = rows[i];
    total += Math.hypot(lab[r * 3] - st[0], lab[r * 3 + 1] - st[1], lab[r * 3 + 2] - st[2]);
  }
  return { rows, slotRgb, distance: total / s.n };
}
