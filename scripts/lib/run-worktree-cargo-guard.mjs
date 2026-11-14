/**
 * The pure half of scripts/run-worktree-cargo-guard.mjs: given the cargo
 * command a no-mistakes run worktree just tried, the same command through
 * scripts/gpui-build.mjs, run from the worktree root.
 */
import path from "node:path";

// Subcommands that compile, so the guard refuses them; `fmt`, `metadata`,
// `tree` and the rest pass through (some still ask rustc for its version).
const COMPILING = new Set(["build", "b", "check", "c", "clippy", "test", "t", "bench", "doc", "d", "rustc", "rustdoc", "run", "r", "fix", "install"]);
// Cargo's global options that take a value as the next argument.
const GLOBAL_WITH_VALUE = new Set(["--config", "-Z", "-C", "--color"]);

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * `cargoArgs` are the outermost cargo's arguments after the program name;
 * `cwd` is where it ran and `manifestDir` the directory of the Cargo.toml it
 * picked, both relative to the checkout root with `/` separators ("" for the
 * root). Returns `{ compiles: false }` for a subcommand that builds nothing,
 * otherwise `{ compiles: true, command, note }` where `note` is set for
 * `cargo run`, which becomes a build.
 */
export function gpuiBuildCommand(cargoArgs, cwd, manifestDir) {
  let index = 0;
  while (index < cargoArgs.length && /^[-+]/.test(cargoArgs[index])) index += GLOBAL_WITH_VALUE.has(cargoArgs[index]) ? 2 : 1;
  const subcommand = cargoArgs[index];
  if (!COMPILING.has(subcommand)) return { compiles: false };

  const rest = cargoArgs.slice(index + 1);
  const end = rest.indexOf("--") >= 0 ? rest.indexOf("--") : rest.length;
  const fromRoot = (value) => (path.posix.isAbsolute(value) ? value : path.posix.normalize(path.posix.join(cwd || ".", value)));
  let hasManifest = false;
  const args = rest.map((arg, i) => {
    if (i >= end) return arg;
    if (arg.startsWith("--manifest-path=")) {
      hasManifest = true;
      return `--manifest-path=${fromRoot(arg.slice("--manifest-path=".length))}`;
    }
    if (i > 0 && rest[i - 1] === "--manifest-path") {
      hasManifest = true;
      return fromRoot(arg);
    }
    return arg;
  });
  // gpui-build runs cargo in gpui/, so any other workspace or member cargo
  // picked from the directory it ran in needs its manifest named.
  if (!hasManifest && manifestDir && manifestDir !== "gpui") args.splice(end, 0, "--manifest-path", `${manifestDir}/Cargo.toml`);

  const run = subcommand === "run" || subcommand === "r";
  const command = ["node", "scripts/gpui-build.mjs", "--", run ? "build" : subcommand, ...args].map(quote).join(" ");
  const note = run
    ? "That builds instead of running: run the copied-back gpui/target/<profile>/lattice-gpui yourself, on a scratch HOME (gpui/script/e2e). Never run the Tauri host."
    : undefined;
  return { compiles: true, command, note };
}
