// Shapes of site/public/data/*.json, written by scripts/export_site_data.py.

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
}

// [post index, filename, width, height, year, title]
export type ArtworkRow = [number, string, number, number, number | null, string | null];

export const imgUrl = (post: Post, file: string) => `/img/${post.dir}/${file}`;

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
