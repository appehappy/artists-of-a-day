// v0 runs with `npm run dev` only: public/img and public/thumbs are symlinks into
// ~13 GB of images in Dropbox, which `astro build` would copy into dist/.
// Publishing needs an image host first.
import path from "node:path";
import { defineConfig } from "astro/config";

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
  prefetch: { prefetchAll: false, defaultStrategy: "hover" },
  devToolbar: { enabled: false },
  vite: { plugins: [reloadOnDataExport()] },
});
