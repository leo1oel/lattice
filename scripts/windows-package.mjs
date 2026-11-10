// Run only after the installed-app checks and uninstall succeed.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { capture, projectRoot, readJson, sha256, writeJson } from "./lib/util.mjs";
import { checkWindowsPackage, windowsAssetNames } from "./lib/windows-package.mjs";

const output = resolve(process.argv[2] ?? ".tmp/windows-package");
const { version } = readJson(join(projectRoot, "src-tauri/tauri.conf.json"));
const names = windowsAssetNames(version);
const sourceCommit = capture("git", ["rev-parse", "HEAD"], { cwd: projectRoot }).trim();
const installer = join(projectRoot, `src-tauri/target/release/bundle/nsis/Lattice_${version}_x64-setup.exe`);
mkdirSync(output, { recursive: true });
cpSync(installer, join(output, names.installer));
const digest = sha256(readFileSync(installer));
writeFileSync(join(output, names.checksum), `${digest}  ${names.installer}\n`);
writeJson(join(output, names.metadata), {
  version, sourceCommit, target: "x86_64-pc-windows-msvc", sha256: digest,
  experimental: true, agentAvailable: false, autoUpdate: false, unsigned: true,
  run: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
});
writeFileSync(join(output, names.instructions), `Lattice ${version} — experimental Windows x64\n\n`
  + `Source: ${sourceCommit}\nInstaller SHA-256: ${digest}\n\n`
  + "This installer is unsigned. Windows SmartScreen may show an unknown-publisher warning. "
  + "Verify the download's origin and SHA-256 before deciding whether to run it. "
  + "Do not disable SmartScreen or your antivirus.\n\n"
  + "Windows 10 1809 or later is required; Windows 11 is recommended. "
  + "The per-user installer uses Microsoft Edge WebView2 (the installer offers the official runtime when needed). "
  + "Install TeX Live for Windows separately to compile LaTeX.\n\n"
  + "The embedded Agent is unavailable. Automatic updates are disabled: download each new version manually. "
  + "One-click TeX/paper-tool installation and rtex live preview are unavailable. "
  + "Open-licensed interface fonts are used; no private font or product-license secrets are included.\n\n"
  + "Uninstall through Windows Settings > Apps > Lattice. Your projects remain your own files.\n");
checkWindowsPackage(output, { version, sha: sourceCommit });
console.log(`Checked experimental Windows package: ${names.installer}`);
