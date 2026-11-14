import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gpuiBuildCommand, repoLevelWrapper } from "./run-worktree-cargo-guard.mjs";

describe("gpuiBuildCommand", () => {
  it("passes through subcommands that build nothing", () => {
    expect(gpuiBuildCommand(["metadata", "--format-version", "1"], "gpui", "gpui")).toEqual({ compiles: false });
    expect(gpuiBuildCommand(["fmt", "--check"], "", undefined)).toEqual({ compiles: false });
    expect(gpuiBuildCommand(["--config", "build.jobs=2", "tree"], "gpui", "gpui")).toEqual({ compiles: false });
  });

  it("sends a gpui/ command through gpui-build unchanged", () => {
    expect(gpuiBuildCommand(["test", "-p", "lattice-ui", "--", "--include-ignored"], "gpui", "gpui").command).toBe(
      "node scripts/gpui-build.mjs -- test -p lattice-ui -- --include-ignored",
    );
    expect(gpuiBuildCommand(["+1.99.1", "-Z", "x", "clippy", "--workspace"], "gpui", "gpui").command).toBe(
      "node scripts/gpui-build.mjs -- clippy --workspace",
    );
  });

  it("names the manifest cargo picked from where it ran", () => {
    expect(gpuiBuildCommand(["clippy", "--all-targets", "--", "-D", "warnings"], "src-tauri/src", "src-tauri").command).toBe(
      "node scripts/gpui-build.mjs -- clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings",
    );
    expect(gpuiBuildCommand(["test"], "gpui/crates/lattice-ui", "gpui/crates/lattice-ui").command).toBe(
      "node scripts/gpui-build.mjs -- test --manifest-path gpui/crates/lattice-ui/Cargo.toml",
    );
  });

  it("rewrites a relative --manifest-path to the worktree root", () => {
    expect(gpuiBuildCommand(["check", "--manifest-path", "../src-tauri/Cargo.toml"], "gpui", "gpui").command).toBe(
      "node scripts/gpui-build.mjs -- check --manifest-path src-tauri/Cargo.toml",
    );
    expect(gpuiBuildCommand(["check", "--manifest-path=src-tauri/Cargo.toml"], "", undefined).command).toBe(
      "node scripts/gpui-build.mjs -- check --manifest-path=src-tauri/Cargo.toml",
    );
  });

  it("turns cargo run into a build and says so", () => {
    const result = gpuiBuildCommand(["run", "--release", "--", "/tmp/project"], "gpui", "gpui");
    expect(result.command).toBe("node scripts/gpui-build.mjs -- build --release -- /tmp/project");
    expect(result.note).toMatch(/builds instead of running/);
  });

  it("quotes arguments the shell would split", () => {
    expect(gpuiBuildCommand(["test", "--", "name with space"], "gpui", "gpui").command).toBe(
      "node scripts/gpui-build.mjs -- test -- 'name with space'",
    );
  });
});

describe("repoLevelWrapper", () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** A worktrees/<repo>/ directory with one run whose guard script echoes what it was given. */
  function layout() {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "run-worktree-guard-")));
    dirs.push(root);
    const runs = path.join(root, "worktrees", "repo");
    mkdirSync(path.join(runs, "run-1", "scripts"), { recursive: true });
    mkdirSync(path.join(runs, "run-1", "gpui"), { recursive: true });
    writeFileSync(path.join(runs, "run-1", "scripts", "run-worktree-cargo-guard.mjs"), "console.log(['guard', ...process.argv.slice(2)].join(' '));\n");
    const wrapper = path.join(runs, ".cargo", "lattice-rustc-wrapper.sh");
    mkdirSync(path.dirname(wrapper), { recursive: true });
    writeFileSync(wrapper, repoLevelWrapper("# marker", runs), { mode: 0o755 });
    return { root, runs, wrapper };
  }
  const run = (wrapper, cwd, env = {}) =>
    spawnSync("sh", [wrapper, "rustc", "-vV"], { cwd, encoding: "utf8", env: { ...process.env, LATTICE_ALLOW_LOCAL_CARGO: "", ...env } });

  it("hands a call made inside a run worktree to that worktree's guard", () => {
    const { runs, wrapper } = layout();
    expect(run(wrapper, path.join(runs, "run-1", "gpui")).stdout.trim()).toBe("guard refuse rustc -vV");
  });

  it("refuses a call it cannot place in a run worktree", () => {
    const { root, wrapper } = layout();
    const result = run(wrapper, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node scripts/gpui-build.mjs -- <the same cargo arguments>");
  });

  it("runs rustc directly under LATTICE_ALLOW_LOCAL_CARGO", () => {
    const { root, wrapper } = layout();
    const result = spawnSync("sh", [wrapper, "echo", "direct"], { cwd: root, encoding: "utf8", env: { ...process.env, LATTICE_ALLOW_LOCAL_CARGO: "1" } });
    expect(result.stdout.trim()).toBe("direct");
  });
});
