// The ~13 GB of artwork isn't part of the site: media/img and media/thumbs are symlinks
// into Dropbox, served by the dev server below. The hosted build (npm run build:archive)
// sits under SITE_BASE on the archive domain and takes its images from
// PUBLIC_IMAGE_BASE (Cloudflare R2; see scripts/upload_images.sh).
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "astro/config";

const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };

// Dev only: /img/… and /thumbs/… come straight from media/ (outside public/, so a
// build never copies them).
function serveMedia() {
  return {
    name: "serve-media",
    configureServer(server) {
      const base = (process.env.SITE_BASE || "/").replace(/\/?$/, "/");
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url || "").split("?")[0]);
        const rel = url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, "");
        if (!/^(img|thumbs)\//.test(rel) || rel.includes("..")) return next();
        const file = path.resolve("media", rel);
        fs.stat(file, (err, st) => {
          if (err || !st.isFile()) return next();
          res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
          res.setHeader("Content-Length", st.size);
          res.setHeader("Cache-Control", "public, max-age=3600");
          fs.createReadStream(file).pipe(res);
        });
      });
    },
  };
}

// src/lib/data.ts reads public/data/*.json once and the dev server caches it. When
// export_site_data.py rewrites those files, drop the cached module and reload pages.
function reloadOnDataExport() {
  return {
    name: "reload-on-data-export",
    configureServer(server) {
      const dataDir = path.resolve("public/data");
      let timer;
      server.watcher.add(path.join(dataDir, "site.json"));
      server.watcher.on("change", (file) => {
        if (!file.startsWith(dataDir) || !file.endsWith("site.json")) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const mod of server.moduleGraph.idToModuleMap.values()) {
            if (mod.file?.endsWith(path.join("src", "lib", "data.ts"))) {
              server.moduleGraph.invalidateModule(mod);
            }
          }
          server.ws.send({ type: "full-reload" });
        }, 500);
      });
    },
  };
}

export default defineConfig({
  base: process.env.SITE_BASE || "/",
  // Hosted, each page is one file (explore/colour.html), which Netlify serves at
  // /explore/colour with no redirect; a folder-per-page build would answer with a
  // redirect to /explore/colour/, which the archive domain's proxy would get wrong.
  build: { format: process.env.SITE_BASE ? "file" : "directory" },
  prefetch: { prefetchAll: false, defaultStrategy: "hover" },
  devToolbar: { enabled: false },
  vite: {
    plugins: [reloadOnDataExport(), serveMedia()],
    // Never watch the image folders: the symlinks lead to ~190k files in Dropbox, and
    // crawling them pins the CPU and memory.
    server: {
      watch: {
        ignored: ["**/media/**", "**/public/fields/**",
                  "**/public/data/similar/**", "**/public/review/**"],
        followSymlinks: false,
      },
    },
  },
});
