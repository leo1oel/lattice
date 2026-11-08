import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./lib/util.mjs";
for (const path of [
  "dist/index.html", "src-tauri/synara-runtime/bin/node.exe",
  "src-tauri/synara-runtime/bin/uv.exe", "src-tauri/synara-runtime/bin/uvx.exe",
  "src-tauri/synara-runtime/bin/bibtex-tidy.cmd", "src-tauri/presentation-runtime/server.mjs",
]) {
  if (!existsSync(join(projectRoot, path))) throw new Error(`Missing Windows resource: ${path}. Run pnpm build and pnpm prepare:windows first.`);
}
for (const file of ["node.exe", "uv.exe", "uvx.exe"]) {
  if (readFileSync(join(projectRoot, "src-tauri/synara-runtime/bin", file)).subarray(0, 2).toString() !== "MZ") throw new Error(`Not a Windows executable: ${file}`);
}
console.log("Windows application resources verified.");
