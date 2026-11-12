// The Century: the archive's works as plates of ten rows by ten squares. On a century
// plate each square is a year and each row a decade; on the Earlier plate each square
// is a decade and each row a century. A square is a 3×3 quilt: one slot per medium
// (SLOT), holding that medium's shape and colour when the archive has works from then,
// in one of three sizes by how many a year, on one scale for every medium and period
// (SIZE_FROM). Each square turns a quarter on from the last (turnOf).
// After Elizabeth Palmer Peabody's charts on Bem's principle (1856).

import type { ArtworkRow } from "./types";

export interface Plate {
  key: string;
  start: number; // first year of the first square
  unit: number; // years per square: 1, or 10 on the Earlier plate
  rows: number; // ten squares each
  end: number; // last year shown (the 2000s stop at the current decade)
}

/** How a work's year is known: dated by its source; a close estimate (the dated works
 *  beside it in its post, within a few years); or rough (look-alikes, the artist's
 *  lifetime, or a stated range too wide to place: "1950s", "20th century"). */
export const DATED = 0, CLOSE = 1, ROUGH = 2;
// A stated range is only a rough placing once it is wider than its square can hold:
// five years on the year squares ("1950s" would otherwise pile onto one year), twenty
// on the decade squares before 1800.
const wideRange = (year: number) => (year < 1800 ? 20 : 5);

export interface Tally { dated: number; close: number; rough: number }
const blank = (): Tally => ({ dated: 0, close: 0, rough: 0 });
const FIELD = ["dated", "close", "rough"] as const;

export interface CenturyData {
  plates: Plate[];
  years: Map<number, Tally[]>; // year -> one per medium
  works: Map<number, ArtworkRow[]>; // year -> its works
  total: number; // works in the collection (each counted once)
  older: number; // works from before the first plate
  undated: number; // works nothing dates, not even roughly
  copies: number; // later posts of works already counted
}

const FIRST = 1000; // earliest year any plate can show

/** Where a work sits and how surely: a stated year, the middle of a stated range
 *  ("1962–65" is 1963), or its estimate. */
export function placement(r: ArtworkRow): { year: number; kind: number } | null {
  const [start, est, end, estKind] = [r[4], r[8], r[9], r[10]];
  if (start != null) {
    if (end == null || end <= start) return { year: start, kind: DATED };
    const year = Math.floor((start + end) / 2);
    return { year, kind: end - start >= wideRange(year) ? ROUGH : DATED };
  }
  return est != null ? { year: est, kind: estKind === CLOSE ? CLOSE : ROUGH } : null;
}
export const yearOf = (r: ArtworkRow) => placement(r)?.year ?? null;
export const kindOf = (r: ArtworkRow) => placement(r)?.kind ?? ROUGH;
export const isDated = (r: ArtworkRow) => kindOf(r) === DATED;
export const isCopy = (r: ArtworkRow) => r[11] === 1;

export function tally(rows: ArtworkRow[], mediaCount: number, thisYear: number): CenturyData {
  const years = new Map<number, Tally[]>();
  const works = new Map<number, ArtworkRow[]>();
  let total = 0, older = 0, undated = 0, copies = 0;
  for (const r of rows) {
    if (r[7] == null) continue; // not one artwork
    if (isCopy(r)) { copies++; continue; }
    total++;
    const at = placement(r);
    if (!at || at.year > 2099) { undated++; continue; }
    if (at.year < FIRST) { older++; continue; }
    let t = years.get(at.year);
    if (!t) {
      t = Array.from({ length: mediaCount }, blank);
      years.set(at.year, t);
      works.set(at.year, []);
    }
    t[r[7]][FIELD[at.kind]]++;
    works.get(at.year)!.push(r);
  }

  // The first plate starts at the first century with any works in it.
  const earliest = Math.min(1700, ...[...years.keys()].filter((y) => y < 1800));
  const early = Math.floor(earliest / 100) * 100;
  for (const [y, list] of works) if (y < early) { older += list.length; }
  const now = Math.floor(thisYear / 10) * 10 + 9;
  const plates: Plate[] = [
    { key: "early", start: early, unit: 10, rows: (1800 - early) / 100, end: 1799 },
    { key: "1800", start: 1800, unit: 1, rows: 10, end: 1899 },
    { key: "1900", start: 1900, unit: 1, rows: 10, end: 1999 },
    { key: "2000", start: 2000, unit: 1, rows: (now - 1999) / 10, end: now },
  ];
  return { plates, years, works, total, older, undated, copies };
}

/** First year of square i. */
export const squareStart = (p: Plate, i: number) => p.start + i * p.unit;

/** "1937", or "1340s" on the Earlier plate. */
export const squareLabel = (p: Plate, i: number) => `${squareStart(p, i)}${p.unit > 1 ? "s" : ""}`;

/** The square holding a year, or null when the plate doesn't. */
export const squareOf = (p: Plate, year: number) =>
  year >= p.start && year <= p.end ? Math.floor((year - p.start) / p.unit) : null;

export const plateOf = (d: CenturyData, year: number) => d.plates.find((p) => squareOf(p, year) != null) ?? null;

/** "1900–1999"; the 2000s run to now. */
export const plateTitle = (p: Plate, thisYear: number) => `${p.start}–${Math.min(p.end, thisYear)}`;

export function squareTally(d: Pick<CenturyData, "years">, p: Plate, i: number, mediaCount: number): Tally[] {
  const sum = Array.from({ length: mediaCount }, blank);
  for (let y = squareStart(p, i); y < squareStart(p, i) + p.unit; y++) {
    d.years.get(y)?.forEach((t, m) => { sum[m].dated += t.dated; sum[m].close += t.close; sum[m].rough += t.rough; });
  }
  return sum;
}

/** A square's works, by medium, the surest dates first, then by year. */
export function squareWorks(d: CenturyData, p: Plate, i: number): ArtworkRow[] {
  const list: ArtworkRow[] = [];
  for (let y = squareStart(p, i); y < squareStart(p, i) + p.unit; y++) list.push(...(d.works.get(y) ?? []));
  return list.sort((a, b) => a[7]! - b[7]! || kindOf(a) - kindOf(b) || yearOf(a)! - yearOf(b)!);
}

/** Works a year at which a shape steps up a size: under 10, 10–99, 100 and over. One
 *  scale for every medium and period, so sizes can be compared anywhere on the page. */
export const SIZE_FROM = [10, 100];
export const sizeOf = (worksAYear: number) => (worksAYear < SIZE_FROM[0] ? 0 : worksAYear < SIZE_FROM[1] ? 1 : 2);

/** Where each medium sits in a square's 3×3, by medium index (aotd/media.py order).
 *  The square is point-symmetric and faces inward: the two triangles in opposite
 *  corners with their right angles to the centre, the arch over the bowl, a quarter
 *  round either side, the two small o's in the outer corners, and drawing's small a
 *  at the heart. */
export const SLOT = [0, 4, 2, 3, 7, 5, 6, 8, 1];

/** Each square turns a quarter on from the one before, so neighbours rhyme. */
export const turnOf = (i: number) => (i % 4) * 90;

/** Each medium's shape, as an SVG path filling an s×s slot, drawn from the wordmark's
 *  four marks (A, o, a, D) turned and scaled to face the square's centre. */
export function shapePath(m: number, s: number): string {
  const h = s / 2, k = s * 0.6, r = s * 0.3, x = (s - k) / 2;
  const circle = (cx: number, cy: number, rr: number) =>
    `M${cx - rr} ${cy}A${rr} ${rr} 0 1 1 ${cx + rr} ${cy}A${rr} ${rr} 0 1 1 ${cx - rr} ${cy}Z`;
  switch (m) {
    case 0: return `M${s} 0V${s}H0Z`; // painting: the A, top left
    case 1: return `M${x + k} ${x}V${x + k}H${x}Z`; // drawing: the small a, at the centre
    case 2: return circle(s - r, r, r); // print: an o in the top-right corner
    case 3: return `M${s} ${s}V0A${s} ${s} 0 0 0 0 ${s}Z`; // sculpture: a quarter round, middle left
    case 4: return `M0 0H${s}V${h}A${h} ${h} 0 0 1 0 ${h}Z`; // ceramics: the D turned down, a bowl
    case 5: return `M0 0H${s}A${s} ${s} 0 0 1 0 ${s}Z`; // installation and media: a quarter round, middle right
    case 6: return circle(r, s - r, r); // photography: the o, in the bottom-left corner
    case 7: return `M0 0H${s}L0 ${s}Z`; // graphic design: the A turned over, bottom right
    default: return `M0 ${s}V${h}A${h} ${h} 0 0 1 ${s} ${h}V${s}Z`; // architecture and product: the D turned up, an arch
  }
}

/** A medium's shape as an icon: the same shape, but every one filling its s×s box,
 *  so a row of them reads at one size. (On the quilt, drawing's small a and the two
 *  small o's are smaller on purpose; as icons they're drawn full size.) */
export function glyphPath(m: number, s: number): string {
  if (m === 1) return shapePath(0, s); // drawing: the a, grown to the A's size
  if (m === 2 || m === 6) {             // print, photography: the o, grown to a full disc
    const h = s / 2;
    return `M0 ${h}A${h} ${h} 0 1 1 ${s} ${h}A${h} ${h} 0 1 1 0 ${h}Z`;
  }
  return shapePath(m, s);
}
