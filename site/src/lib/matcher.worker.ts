// Colour maps: choosing the closest-matching works for a map and shape takes up to a
// second, so it runs here, off the main thread, and the page stays responsive.
// Messages in: { lab } once (OKLab per artwork), then { id, map, slots }.
// Messages out: { id, rows, slotRgb, distance }.

import { match, type ColourMap, type Slots } from "./colourmaps";

let lab: Float32Array | null = null;

self.onmessage = (e: MessageEvent<{ lab?: Float32Array; id?: number; map?: ColourMap; slots?: Slots }>) => {
  if (e.data.lab) { lab = e.data.lab; return; }
  const { id, map, slots } = e.data;
  const m = match(lab!, map!, slots!);
  (self as unknown as Worker).postMessage({ id, ...m }, [m.rows.buffer, m.slotRgb.buffer]);
};
