import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "tools/open-slide-runtime");
const target = join(root, "src-tauri/presentation-runtime");
const stage = join(root, "node_modules/.cache/lattice/presentation-runtime");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of ["package.json", "pnpm-lock.yaml", "server.mjs", "lucide-open-slide.mjs"]) {
  cpSync(join(source, file), join(stage, file));
}
execFileSync("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], { cwd: stage, stdio: "inherit" });
writeFileSync(join(stage, "manifest.json"), JSON.stringify({ openSlideVersion: "1.19.1", viteVersion: "5.4.10" }, null, 2));
rmSync(target, { recursive: true, force: true });
// pnpm's package links are relative to this staged node_modules tree. Preserve
// them verbatim: resolving them while copying would point the app bundle back
// into the build machine's node_modules cache and duplicate every package.
cpSync(stage, target, { recursive: true, verbatimSymlinks: true });
writeFileSync(
  join(target, "placeholder.txt"),
  "Run `pnpm prepare:presentation` to stage the managed Open Slide runtime here.\n",
);
if (!existsSync(join(target, "server.mjs"))) throw new Error("Presentation runtime staging failed");
