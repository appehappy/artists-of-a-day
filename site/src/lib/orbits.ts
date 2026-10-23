// Orbits: a Colour Field view after Alma Thomas — a dark disc at the centre, ringed
// by pills of the archive's most saturated works, hue changing ring by ring from
// green and teal at the centre through blue, purple, red and orange to yellow at
// the edge. Pills grow a little towards the edge and sit slightly askew, like
// brushstrokes.

import type { Layout } from "./mosaic";

export function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const enc = (c: number) => {
    const v = Math.max(0, Math.min(1, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [
    enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export interface OrbitOptions {
  count: number; // roughly how many works to show (rounded up to finish the last ring)
  seed?: number;
}

const START_HUE = 122; // OKLab hue (degrees) of the innermost ring: green, so the
// sequence ends on yellow at the edge
const SUN = oklabToRgb(0.24, -0.015, -0.045); // deep blue-black, as in Thomas's "The Eclipse"

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rings of pills from radius r0 outward until there's room for `count` works. */
function rings(count: number, rand: () => number) {
  const r0 = 7; // the dark disc
  const out: { r: number; t: number; n: number; offset: number }[] = [];
  let r = r0 + 0.6, total = 0;
  while (total < count) {
    const t = 1 + 0.03 * (r - r0); // pill thickness grows towards the edge
    const len = t * 1.6;
    const ringR = r + t / 2;
    const n = Math.max(6, Math.floor((2 * Math.PI * ringR) / (len * 1.14)));
    out.push({ r: ringR, t, n, offset: rand() * 2 * Math.PI });
    total += n;
    r += t * 1.22;
  }
  return { r0, rings: out, total };
}

/**
 * Choose the most saturated works, every hue represented (a hue's share grows with
 * the square root of how common it is, so rare hues still get a ring or two), and
 * lay them out as orbits. `lab` is OKLab per artwork (n×3).
 */
export function orbitLayout(lab: Float32Array, opts: OrbitOptions): Layout {
  const rand = rng(opts.seed ?? 11);
  const count = lab.length / 3;
  const geo = rings(opts.count, rand);
  const n = geo.total;

  const chroma = new Float32Array(count);
  const turn = new Float32Array(count); // degrees from START_HUE
  const BINS = 24;
  const byBin: number[][] = Array.from({ length: BINS }, () => []);
  for (let i = 0; i < count; i++) {
    const a = lab[i * 3 + 1], b = lab[i * 3 + 2];
    chroma[i] = Math.hypot(a, b);
    const h = (Math.atan2(b, a) * 180) / Math.PI;
    turn[i] = (((h - START_HUE) % 360) + 360) % 360;
    byBin[Math.floor((turn[i] / 360) * BINS) % BINS].push(i);
  }
  const weight = byBin.map((bin) => Math.sqrt(bin.length));
  const total = weight.reduce((x, y) => x + y, 0);
  const chosen: number[] = [];
  byBin.forEach((bin, b) => {
    bin.sort((p, q) => chroma[q] - chroma[p]); // most saturated first
    chosen.push(...bin.slice(0, Math.round((weight[b] / total) * n)));
  });
  // Top up or trim to exactly n, by saturation.
  if (chosen.length < n) {
    const have = new Set(chosen);
    const rest = [...Array(count).keys()].filter((i) => !have.has(i)).sort((p, q) => chroma[q] - chroma[p]);
    chosen.push(...rest.slice(0, n - chosen.length));
  }
  chosen.sort((p, q) => chroma[q] - chroma[p]);
  const works = chosen.slice(0, n).sort((p, q) => turn[p] - turn[q]);

  const layout = {
    rows: new Int32Array(n), x: new Float32Array(n), y: new Float32Array(n), t: new Float32Array(n),
    slotRgb: new Float32Array(n * 3), w: new Float32Array(n), h: new Float32Array(n),
    rot: new Float32Array(n), round: 0.42,
  } satisfies Layout;
  let i = 0;
  for (const ring of geo.rings) {
    const members = works.slice(i, i + ring.n);
    // The ring's colour (for the zoom tint): the mean of its works.
    let L = 0, A = 0, B = 0;
    for (const w of members) { L += lab[w * 3]; A += lab[w * 3 + 1]; B += lab[w * 3 + 2]; }
    const rgb = oklabToRgb(L / members.length, A / members.length, B / members.length);
    members.forEach((row, j) => {
      const theta = ring.offset + ((j + (rand() - 0.5) * 0.15) / ring.n) * 2 * Math.PI;
      const r = ring.r + (rand() - 0.5) * 0.12 * ring.t;
      layout.rows[i] = row;
      layout.x[i] = r * Math.sin(theta);
      layout.y[i] = -r * Math.cos(theta);
      layout.rot[i] = theta + (rand() - 0.5) * 0.14; // along the ring, a little askew
      layout.w[i] = ring.t * 1.6 * (0.9 + rand() * 0.18);
      layout.h[i] = ring.t * (0.9 + rand() * 0.12);
      layout.t[i] = i / n;
      layout.slotRgb.set(rgb, i * 3);
      i++;
    });
  }
  return { ...layout, disc: { x: 0, y: 0, r: geo.r0, rgb: SUN } };
}
