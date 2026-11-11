// Shapes of site/public/data/*.json, written by scripts/export_site_data.py.

import { image } from "./paths";

export interface Post {
  id: string;
  date: string; // YYYY-MM-DD the post was featured
  number: number | null;
  url: string;
  kind: "artist" | "group" | "theme";
  subject: string | null;
  descriptor: string | null;
  artist: string | null; // artist slug
  dir: string; // image folder under /img
  intro: string | null; // intro image filename
}

export interface Artist {
  slug: string;
  name: string;
  type: "person" | "group";
  birth: number | null;
  death: number | null;
  nationality: string | null;
  roles: string[];
  disciplines: string[];
  living: boolean;
  posts: number[]; // indexes into posts
  neighbours: string[]; // slugs
  region: string | null;
  wikidata: { qid: string; enwiki: string | null; movements: string[] } | null;
}

export interface Discipline {
  key: string;
  label: string;
  artists: number;
}

export interface SiteData {
  posts: Post[];
  artists: Artist[];
  disciplines: Discipline[];
  regions: { key: string; artists: number }[];
  colours: { key: string; hex: string }[]; // see artworkHasColour
  media: { key: string; label: string }[]; // aotd/media.py, in the plate's 3×3 order
}

// [post index, filename, width, height, year (as its source states it), title,
//  colours (see artworkHasColour), medium (index into SiteData.media; null: not one
//  artwork), year_est (undated works: best guess at when it was made), year_end (the
//  end of a stated range, "1950s" -> 1959), est_kind (how far to trust year_est: 1
//  close, from the dated works beside it in its post; 2 rough, from look-alikes or the
//  artist's lifetime), copy (1: a later post of a work the archive already has)]
export type ArtworkRow = [number, string, number, number, number | null, string | null, number,
                          number | null, number | null, number | null, number, number];

// Similar works for one post, from /data/similar/<post index>.json
export type SimilarMap = Record<string, [number, string][]>;

export const imgUrl = (post: Post, file: string) => image(`img/${post.dir}/${file}`);
export const thumbUrl = (post: Post, file: string) =>
  image(`thumbs/${post.dir}/${file.replace(/\.[a-z]+$/i, ".webp")}`);

export function lifeDates(a: Pick<Artist, "birth" | "death">): string {
  if (a.birth && a.death) return `${a.birth}–${a.death}`;
  if (a.birth) return `b. ${a.birth}`;
  return "";
}

export function formatDate(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

const NEUTRALS = new Set(["black", "grey", "white"]);

/** Colour i (index into SiteData.colours) for an artwork's packed colours int: bits
 *  0–11 mark colours covering >= 12% of the image, bits 12+ hold 1 + its main hue.
 *  Chromatic swatches match the main hue, so a blue backdrop doesn't make a brown
 *  sculpture "blue"; black, grey and white match any noticeable share. */
export function artworkHasColour(packed: number, i: number, key: string): boolean {
  return NEUTRALS.has(key) ? (packed & (1 << i)) !== 0 : packed >> 12 === i + 1;
}
