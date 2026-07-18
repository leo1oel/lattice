import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))),
  "..",
);
const ompPackage = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
const rustVersion = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const target = rustVersion.match(/^host:\s*(.+)$/m)?.[1];

if (!target) {
  throw new Error("Could not determine the Rust host target.");
}

const releases = {
  "aarch64-apple-darwin": {
    asset: "omp-darwin-arm64",
    sha256: "c0d43c47b969efb67fa184f779d183bb52411e98672b769fb0e71d51d59eed68",
  },
  "x86_64-apple-darwin": {
    asset: "omp-darwin-x64",
    sha256: "0e4b5add9cc8f79193b539b5ccca7eae7ec997a705015336bbdb96c18d97d17d",
  },
  "aarch64-unknown-linux-gnu": {
    asset: "omp-linux-arm64",
    sha256: "555046b95b88d1534ff4ca85ea5814ef89cb35fa8aa4af3b0e3d331062da9c2c",
  },
  "x86_64-unknown-linux-gnu": {
    asset: "omp-linux-x64",
    sha256: "319d08ab8e5fb80c73f734907d5f47aa8bbd4ea31f7a19bacf8611c5aba26c31",
  },
  "x86_64-pc-windows-msvc": {
    asset: "omp-windows-x64.exe",
    sha256: "06a02c0e75ac1d01f95d0a66b2db58263541327628f594728dd755c03c098e55",
  },
};
const release = releases[target];

if (!release) {
  throw new Error(`Oh My Pi does not publish a binary for ${target}.`);
}

const cache = join(
  projectRoot,
  "node_modules/.cache/lattice",
  `omp-v${ompPackage.version}-${release.asset.replace(/^omp-/, "")}`,
);
mkdirSync(dirname(cache), { recursive: true });

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!existsSync(cache) || digest(cache) !== release.sha256) {
  rmSync(cache, { force: true });
  const url = `https://github.com/can1357/oh-my-pi/releases/download/v${ompPackage.version}/${release.asset}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download Oh My Pi ${ompPackage.version}: ${response.status}.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(cache));
}

if (digest(cache) !== release.sha256) {
  rmSync(cache, { force: true });
  throw new Error("The downloaded Oh My Pi binary failed its SHA-256 check.");
}

const executableSuffix = target.includes("windows") ? ".exe" : "";
const output = join(
  projectRoot,
  "src-tauri/binaries",
  `lattice-agent-${target}${executableSuffix}`,
);
mkdirSync(dirname(output), { recursive: true });
cpSync(cache, output);
chmodSync(output, 0o755);

const assets = join(projectRoot, "src-tauri/omp-assets");
rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

for (const file of ["package.json", "README.md", "CHANGELOG.md"]) {
  cpSync(join(packageRoot, file), join(assets, file));
}
cpSync(
  join(projectRoot, "src-tauri/src/embedded_skills"),
  join(assets, "skills"),
  { recursive: true },
);
cpSync(
  join(projectRoot, "src-tauri/omp-extension/lattice.ts"),
  join(assets, "lattice.ts"),
);
mkdirSync(join(assets, "LICENSES"), { recursive: true });
cpSync(
  join(projectRoot, "src-tauri/third-party/oh-my-pi-MIT.txt"),
  join(assets, "LICENSES/oh-my-pi-MIT.txt"),
);

console.log(`Prepared Oh My Pi ${ompPackage.version} sidecar for ${target}.`);
