import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * Self-hosts Excalidraw's fonts. Excalidraw loads each face from
 * `window.EXCALIDRAW_ASSET_PATH` + `fonts/<family>/<file>` and, only when that
 * fails, from esm.sh; Lattice is local-first and its CSP allows fonts from
 * 'self' alone, so the build ships the package's own files at
 * `excalidraw-assets/fonts/` beside the app's JavaScript, under the names
 * Excalidraw asks for (`src/editor/board/board-asset-urls.ts` points the asset
 * path there). The dev server serves the same files from node_modules.
 */
export const EXCALIDRAW_ASSETS_DIR = "excalidraw-assets";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontsRoot = path.join(repo, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");

function fontFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? fontFiles(file) : [file];
  });
}

export function excalidrawAssetsPlugin(): Plugin {
  return {
    name: "excalidraw-assets",
    configureServer(server) {
      server.middlewares.use(`/${EXCALIDRAW_ASSETS_DIR}/fonts`, (request, response, next) => {
        const relative = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = path.join(fontsRoot, relative);
        if (!file.startsWith(fontsRoot + path.sep) || !relative.endsWith(".woff2")) return next();
        try {
          const bytes = readFileSync(file);
          response.setHeader("Content-Type", "font/woff2");
          response.end(bytes);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const file of fontFiles(fontsRoot)) {
        const relative = path.relative(fontsRoot, file).split(path.sep).join("/");
        this.emitFile({ type: "asset", fileName: `${EXCALIDRAW_ASSETS_DIR}/fonts/${relative}`, source: readFileSync(file) });
      }
    },
  };
}
