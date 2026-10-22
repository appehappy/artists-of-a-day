// Build-time access to the exported data (server side only).
import fs from "node:fs";
import path from "node:path";
import type { Artist, ArtworkRow, Post, SiteData } from "./types";

const dataDir = path.resolve("public/data");

const site: SiteData = JSON.parse(fs.readFileSync(path.join(dataDir, "site.json"), "utf8"));
const rows: ArtworkRow[] = JSON.parse(
  fs.readFileSync(path.join(dataDir, "artworks.json"), "utf8"),
).rows;

export const posts: Post[] = site.posts;
export const artists: Artist[] = site.artists;
export const disciplines = site.disciplines;
export const regions = site.regions;
export const colours = site.colours;
export const artistBySlug = new Map(artists.map((a) => [a.slug, a]));

export const artworksByPost = new Map<number, ArtworkRow[]>();
for (const r of rows) {
  const list = artworksByPost.get(r[0]) ?? [];
  list.push(r);
  artworksByPost.set(r[0], list);
}

export const disciplineLabel = new Map(disciplines.map((d) => [d.key, d.label]));
