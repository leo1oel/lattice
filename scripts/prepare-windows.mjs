// Stage only the runtimes Windows can use. The guarded Synara agent remains
// unavailable until an equivalent Windows bibliography sandbox exists.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot, run } from "./lib/util.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Run Windows resource preparation on Windows x64.");
const root = join(projectRoot, "src-tauri/synara-runtime");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "bin"), { recursive: true });
const staging = mkdtempSync(join(tmpdir(), "lattice-windows-"));
try {
  for (const item of [
    {
      url: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip",
      sha256: "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba",
      directory: "node-v24.20.0-win-x64", files: ["node.exe", "LICENSE"],
    },
    {
      url: "https://github.com/astral-sh/uv/releases/download/0.12.3/uv-x86_64-pc-windows-msvc.zip",
      sha256: "b23350c79e8ad0192b8124af13a0f17e8d4e4549524785e1aef389ae5a06990e",
      directory: "", files: ["uv.exe", "uvx.exe"],
    },
    {
      url: "https://github.com/jgm/pandoc/releases/download/3.13/pandoc-3.13-windows-x86_64.zip",
      sha256: "23e1f2e978a3df80db8bf65c9c59534f41a23140480cfb4f783a882ab7dc6a4e",
      directory: "pandoc-3.13", files: ["pandoc.exe", "COPYING.rtf", "COPYRIGHT.txt"],
    },
  ]) {
    const archive = join(staging, `${item.files[0]}.zip`);
    const response = await fetch(item.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Download failed: ${item.url}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new Error(`Checksum mismatch: ${item.url}`);
    writeFileSync(archive, bytes);
    const output = join(staging, item.files[0]);
    mkdirSync(output);
    execFileSync("tar.exe", ["-xf", archive, "-C", output], { stdio: "inherit" });
    for (const file of item.files) cpSync(join(output, item.directory, file), join(root, "bin", file));
  }
  const uvLicense = await fetch("https://raw.githubusercontent.com/astral-sh/uv/0.12.3/LICENSE-MIT");
  if (!uvLicense.ok) throw new Error("Could not fetch the uv redistribution license");
  writeFileSync(join(root, "bin/uv-LICENSE-MIT.txt"), await uvLicense.text());
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ platform: "win32-x64", nodeVersion: "24.20.0", uvVersion: "0.12.3", agentAvailable: false }, null, 2));
  // Install the pinned formatter through pnpm so its own lock and integrity
  // checks apply; the Python bibliography tools find this launcher on PATH.
  const formatter = join(staging, "formatter");
  mkdirSync(formatter);
  writeFileSync(join(formatter, "package.json"), JSON.stringify({ private: true, dependencies: { "bibtex-tidy": "1.15.1" } }));
  run("pnpm", ["install", "--prod", "--ignore-scripts", "--config.node-linker=hoisted"], { cwd: formatter });
  cpSync(join(formatter, "node_modules/bibtex-tidy"), join(root, "bibtex-tidy"), { recursive: true });
  const formatterPackage = JSON.parse(readFileSync(join(root, "bibtex-tidy/package.json"), "utf8"));
  const binary = typeof formatterPackage.bin === "string" ? formatterPackage.bin : formatterPackage.bin["bibtex-tidy"];
  if (!binary || !existsSync(join(root, "bibtex-tidy", binary))) throw new Error("Missing BibTeX formatter entry point");
  writeFileSync(join(root, "bin/bibtex-tidy.cmd"), `@echo off\r\n"%~dp0node.exe" "%~dp0..\\bibtex-tidy\\${binary.replaceAll("/", "\\")}" %*\r\n`);
  run(process.execPath, [join(projectRoot, "scripts/prepare-presentation-runtime.mjs")]);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
