import { describe, expect, it } from "vitest";
import { MODULES, modulesFor, readModules } from "./gpui-e2e-modules.mjs";

describe("modulesFor", () => {
  it("picks a module from its own scenario file or folder", () => {
    expect(modulesFor(["gpui/crates/lattice-gpui/src/scenario/e2e/status_bar.rs"]).modules).toEqual(["status_bar"]);
    expect(modulesFor(["gpui/crates/lattice-gpui/src/scenario/e2e/pdf/navigation.rs"]).modules).toEqual(["pdf"]);
    expect(modulesFor(["gpui/crates/lattice-gpui/src/scenario/e2e/markdown_scroll.rs"]).modules).toEqual(["markdown"]);
  });

  it("picks modules from the app source they exercise", () => {
    expect(modulesFor(["gpui/crates/lattice-gpui/src/file_tree/naming.rs", "gpui/crates/lattice-gpui/src/submission.rs"]).modules).toEqual(["submission", "submission_checklist", "tree"]);
  });

  it("picks the dock steps from the layout code", () => {
    expect(modulesFor(["gpui/crates/trellis/src/lib.rs", "gpui/crates/lattice-gpui/src/scenario/shell_steps.rs"]).modules).toEqual(["dock"]);
  });

  it("picks none for shared files and nothing GPUI for the rest", () => {
    expect(modulesFor(["gpui/crates/lattice-gpui/src/shell.rs", "gpui/Cargo.lock"])).toMatchObject({ gpui: true, modules: [] });
    expect(modulesFor(["src/App.tsx"])).toMatchObject({ gpui: false, modules: [] });
  });

  it("reads every module the scenario registers, and only those", () => {
    expect(MODULES).toEqual([
      "agent", "assets", "build_flow", "design_calls", "dock", "documents", "editor_adapter", "fluid", "get_started",
      "help", "history", "islands", "live_controls", "live_preview", "markdown", "narrow_window", "overleaf", "pdf",
      "saves", "settings", "source_chrome", "status_bar", "structured", "submission", "submission_checklist",
      "tab_strip", "tree",
    ]);
    // The helpers beside the modules register nothing.
    for (const helper of ["steps", "registry", "markdown_pages", "terminal", "editor_pointer"]) expect(MODULES).not.toContain(helper);
  });

  it("reads a module's covers from its file", () => {
    expect(readModules().get("assets")).toEqual([
      "gpui/crates/lattice-gpui/src/assets.rs",
      "gpui/crates/lattice-gpui/src/asset_preview.rs",
      "gpui/crates/lattice-gpui/src/shell/assets.rs",
    ]);
    expect(readModules().get("fluid")).toEqual([]);
  });
});
