// v0 runs with `npm run dev` only: public/img is a symlink to ~10 GB of images in
// Dropbox, which `astro build` would copy into dist/. Publishing needs thumbnails
// and an image host first.
import { defineConfig } from "astro/config";

export default defineConfig({
  prefetch: { prefetchAll: false, defaultStrategy: "hover" },
  devToolbar: { enabled: false },
});
