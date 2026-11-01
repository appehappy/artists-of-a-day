// Browser-side data loading, shared by every page. Module state survives
// client-side navigation, so each file is fetched once per visit.
import { at } from "./paths";
import type { ArtworkRow, SiteData } from "./types";

let sitePromise: Promise<SiteData> | null = null;
let artworksPromise: Promise<ArtworkRow[]> | null = null;

export function loadSite(): Promise<SiteData> {
  sitePromise ??= fetch(at("data/site.json")).then((r) => r.json());
  return sitePromise;
}

export function loadArtworks(): Promise<ArtworkRow[]> {
  artworksPromise ??= fetch(at("data/artworks.json")).then((r) => r.json()).then((d) => d.rows);
  return artworksPromise;
}

// Small seeded PRNG so a shuffled order can be restored after navigating back.
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Run `init` on every page view (first load and client-side navigations). */
export function onPage(selector: string, init: (root: HTMLElement) => void) {
  document.addEventListener("astro:page-load", () => {
    const root = document.querySelector<HTMLElement>(selector);
    if (root) init(root);
  });
}
