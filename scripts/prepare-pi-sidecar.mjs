import { cpSync, chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(
  projectRoot,
  "node_modules/@earendil-works/pi-coding-agent",
);
const rustVersion = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const target = rustVersion.match(/^host:\s*(.+)$/m)?.[1];

if (!target) {
  throw new Error("Could not determine the Rust host target.");
}

const executableSuffix = target.includes("windows") ? ".exe" : "";
const output = join(
  projectRoot,
  "src-tauri/binaries",
  `lattice-agent-${target}${executableSuffix}`,
);
const bun = join(
  projectRoot,
  "node_modules/bun/bin",
  "bun.exe",
);

mkdirSync(dirname(output), { recursive: true });
execFileSync(
  bun,
  [
    "build",
    "--compile",
    join(packageRoot, "dist/bun/cli.js"),
    "--outfile",
    output,
  ],
  { cwd: projectRoot, stdio: "inherit" },
);
chmodSync(output, 0o755);

const assets = join(projectRoot, "src-tauri/pi-assets");
rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

for (const file of ["package.json", "README.md", "CHANGELOG.md"]) {
  cpSync(join(packageRoot, file), join(assets, file));
}
for (const [source, destination] of [
  ["dist/core/export-html", "export-html"],
  ["dist/modes/interactive/theme", "theme"],
  ["dist/modes/interactive/assets", "assets"],
]) {
  cpSync(join(packageRoot, source), join(assets, destination), { recursive: true });
}
cpSync(
  join(projectRoot, "src-tauri/src/embedded_skills"),
  join(assets, "skills"),
  { recursive: true },
);
cpSync(
  join(projectRoot, "src-tauri/pi-extension/lattice.ts"),
  join(assets, "lattice.ts"),
);
mkdirSync(join(assets, "LICENSES"), { recursive: true });
cpSync(
  join(projectRoot, "src-tauri/third-party/pi-MIT.txt"),
  join(assets, "LICENSES/pi-MIT.txt"),
);

const piPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
console.log(`Prepared Pi ${piPackage.version} sidecar for ${target}.`);
