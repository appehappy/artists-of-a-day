// Constellation: every artwork as a star in a galaxy of visual likeness
// (scripts/build_fields.py). Works cluster into systems by their CLIP embeddings —
// a bright core of the most typical works fading into a halo — with streams of
// in-between works where related systems collide. Constellation lines join each
// system to its most alike neighbours; names appear from afar, regions closer in.

import type { Layout } from "./mosaic";
import { oklabToRgb } from "./orbits";

export interface Galaxy {
  stars: Float32Array; // x, y, size, t per artwork
  labels: NonNullable<Layout["labels"]>;
  links: NonNullable<Layout["links"]>;
}

export async function loadGalaxy(base = "/fields/constellation"): Promise<Galaxy> {
  const ok = (r: Response) => { if (!r.ok) throw new Error(r.url); return r; };
  const [stars, meta] = await Promise.all([
    fetch(`${base}/stars.bin`).then(ok).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
    fetch(`${base}/galaxy.json`).then(ok).then((r) => r.json()),
  ]);
  return { stars, labels: meta.labels, links: meta.links };
}

/** The galaxy as a layout: round stars, tinted from afar by each work's mean colour
 *  (`lab`, OKLab per artwork), spiralling out from the centre on arrival. */
export function galaxyLayout(g: Galaxy, lab: Float32Array): Layout {
  const n = g.stars.length / 4;
  const layout = {
    rows: new Int32Array(n), x: new Float32Array(n), y: new Float32Array(n), t: new Float32Array(n),
    slotRgb: new Float32Array(n * 3), w: new Float32Array(n), h: new Float32Array(n), round: 0.5,
  } satisfies Layout;
  for (let i = 0; i < n; i++) {
    layout.rows[i] = i;
    layout.x[i] = g.stars[i * 4];
    layout.y[i] = g.stars[i * 4 + 1];
    layout.w[i] = layout.h[i] = g.stars[i * 4 + 2];
    layout.t[i] = g.stars[i * 4 + 3];
    layout.slotRgb.set(oklabToRgb(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]), i * 3);
  }
  return {
    ...layout, labels: g.labels, links: g.links, enter: "spiral", stagger: 2600,
    twinkle: true, rotate: 0.0035, // stars glint, signals cross, and it turns once in ~30 minutes when idle
    disc: { x: 0, y: 0, r: 0, rgb: null }, // where the loading clock turns
  };
}
