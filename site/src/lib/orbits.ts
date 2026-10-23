// Orbits: the Colour Field, after Alma Thomas — a dark sun at the centre, ringed by
// pills of the archive's most colourful works, hue changing ring by ring from green
// and teal at the centre through blue, purple, red and orange to yellow at the edge.
// Every pill is the same size, evenly spaced along its ring. Works are placed by their
// signature colour (their tile's strongest hue, scripts/build_colourmaps.py), so a
// red-and-white poster counts as red.

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

const START_HUE = 122; // OKLab hue (degrees) of the innermost ring: green, so the
// sequence ends on yellow at the edge
const SUN = oklabToRgb(0.24, -0.015, -0.045); // deep blue-black, as in Thomas's "The Eclipse"
const PILL_W = 1.6; // cells, along the ring
const PILL_H = 1; // cells, across it
const SPACING = 0.18; // cells between pills along a ring
const PITCH = 1.22; // cells from one ring to the next
const SUN_SHARE = 0.18; // the sun's radius as a share of the whole
const DRIFT = 0.03; // radians per second of the innermost rings when idle; slower outward

/** Rings of evenly spaced pills around a sun sized to the whole, until there's room
 *  for `count` works. */
function rings(count: number) {
  const area = (PILL_W + SPACING) * PITCH;
  const outer = Math.sqrt((count * area) / (Math.PI * (1 - SUN_SHARE ** 2)));
  const sun = Math.round(outer * SUN_SHARE);
  const out: { r: number; n: number }[] = [];
  let total = 0;
  for (let r = sun + 0.6 + PILL_H / 2; total < count; r += PITCH) {
    const n = Math.floor((2 * Math.PI * r) / (PILL_W + SPACING));
    out.push({ r, n });
    total += n;
  }
  return { sun, rings: out, total };
}

/**
 * Choose the most colourful works, every hue represented (a hue's share grows with
 * the square root of how many colourful works have it, so rare hues still get a ring
 * or two), and lay them out as orbits. `sig` is (L, a, b, share) per artwork.
 */
export function orbitLayout(sig: Float32Array, count: number): Layout {
  const works = sig.length / 4;
  const geo = rings(count);
  const n = geo.total;

  // How colourful a work reads: its signature colour's chroma, discounted when that
  // colour covers little of the tile.
  const vivid = new Float32Array(works);
  const turn = new Float32Array(works); // degrees from START_HUE
  const BINS = 24;
  const byBin: number[][] = Array.from({ length: BINS }, () => []);
  for (let i = 0; i < works; i++) {
    const a = sig[i * 4 + 1], b = sig[i * 4 + 2], share = sig[i * 4 + 3];
    vivid[i] = Math.hypot(a, b) * Math.sqrt(Math.min(share, 0.4) / 0.4);
    turn[i] = ((((Math.atan2(b, a) * 180) / Math.PI - START_HUE) % 360) + 360) % 360;
    byBin[Math.floor((turn[i] / 360) * BINS) % BINS].push(i);
  }
  const weight = byBin.map((bin) => Math.sqrt(bin.filter((i) => vivid[i] >= 0.05).length));
  const total = weight.reduce((x, y) => x + y, 0);
  const chosen: number[] = [];
  byBin.forEach((bin, b) => {
    bin.sort((p, q) => vivid[q] - vivid[p]);
    chosen.push(...bin.slice(0, Math.round((weight[b] / total) * n)));
  });
  // Top up or trim to exactly n, by colourfulness.
  if (chosen.length < n) {
    const have = new Set(chosen);
    const rest = [...Array(works).keys()].filter((i) => !have.has(i)).sort((p, q) => vivid[q] - vivid[p]);
    chosen.push(...rest.slice(0, n - chosen.length));
  }
  chosen.sort((p, q) => vivid[q] - vivid[p]);
  const order = chosen.slice(0, n).sort((p, q) => turn[p] - turn[q]);

  const layout = {
    rows: new Int32Array(n), x: new Float32Array(n), y: new Float32Array(n), t: new Float32Array(n),
    slotRgb: new Float32Array(n * 3), w: new Float32Array(n).fill(PILL_W), h: new Float32Array(n).fill(PILL_H),
    rot: new Float32Array(n), spin: new Float32Array(n), round: 0.42,
  } satisfies Layout;
  let i = 0;
  geo.rings.forEach((ring, k) => {
    const offset = (k * 0.618 * 2 * Math.PI) / ring.n; // so pills don't line up into spokes
    const spin = (k % 2 ? 1 : -1) * DRIFT * Math.sqrt(geo.rings[0].r / ring.r);
    for (let j = 0; j < ring.n; j++) {
      const row = order[i];
      const theta = offset + (j / ring.n) * 2 * Math.PI;
      layout.rows[i] = row;
      layout.x[i] = ring.r * Math.sin(theta);
      layout.y[i] = -ring.r * Math.cos(theta);
      layout.rot[i] = theta; // along the ring
      layout.spin[i] = spin;
      layout.t[i] = (k + j / ring.n) / geo.rings.length; // spiral out, ring by ring
      layout.slotRgb.set(oklabToRgb(sig[row * 4], sig[row * 4 + 1], sig[row * 4 + 2]), i * 3);
      i++;
    }
  });
  return { ...layout, disc: { x: 0, y: 0, r: geo.sun, rgb: SUN }, stagger: 2400, enter: "spiral" };
}
