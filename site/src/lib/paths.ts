// Where the site lives and where its images come from. In dev both are the root; the
// hosted build sits under a path on the archive domain (SITE_BASE, astro.config.mjs)
// and its images come from an image host (PUBLIC_IMAGE_BASE), since the ~13 GB of
// artwork is too big to ship with the site.

/** The site's base path, always ending in "/" ("/" in dev). */
export const BASE = import.meta.env.BASE_URL.replace(/\/?$/, "/");

/** A site path ("explore/colour", "/data/site.json") under the base. */
export const at = (path: string) => BASE + path.replace(/^\//, "");

/** A pathname with the base taken off, so routes can be compared ("/explore/colour"). */
export const route = (pathname: string) =>
  pathname.startsWith(BASE) ? "/" + pathname.slice(BASE.length) : pathname;

/** Where /img and /thumbs are served from: the image host, else the site itself. */
const IMAGES = (import.meta.env.PUBLIC_IMAGE_BASE || BASE).replace(/\/$/, "");
export const image = (path: string) => `${IMAGES}/${path.replace(/^\//, "")}`;
