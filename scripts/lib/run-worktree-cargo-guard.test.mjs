import { describe, expect, it } from "vitest";
import { gpuiBuildCommand } from "./run-worktree-cargo-guard.mjs";

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
