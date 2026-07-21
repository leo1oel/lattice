import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** Ship pdf.js CMaps + standard fonts next to the web assets (needed offline in Tauri). */
function pdfjsAssetsPlugin(): Plugin {
  const copy = () => {
    const pdfjsRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
    const outRoot = path.resolve("public/pdfjs");
    mkdirSync(outRoot, { recursive: true });
    cpSync(path.join(pdfjsRoot, "cmaps"), path.join(outRoot, "cmaps"), { recursive: true });
    cpSync(path.join(pdfjsRoot, "standard_fonts"), path.join(outRoot, "standard_fonts"), {
      recursive: true,
    });
  };
  return {
    name: "pdfjs-assets",
    buildStart: copy,
    configureServer() {
      copy();
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), pdfjsAssetsPlugin()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@lezer")) return "parser";
          if (id.includes("@codemirror") || id.includes("@uiw/react-codemirror") || id.includes("codemirror-lang-latex")) return "editor";
          if (id.includes("marked") || id.includes("dompurify")) return "paper-reader";
          if (id.includes("pdfjs-dist")) return "pdf-reader";
          if (id.includes("gsap")) return "motion";
          if (id.includes("node_modules/react") || id.includes("node_modules/lucide-react")) return "ui";
          return undefined;
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
