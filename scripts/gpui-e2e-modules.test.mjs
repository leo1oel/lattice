import { describe, expect, it } from "vitest";
import { MODULES, modulesFor, readModules } from "./gpui-e2e-modules.mjs";

describe("modulesFor", () => {
  it("picks a module from its own scenario file or folder", () => {
    expect(modulesFor(["gpui/crates/lattice-gpui/src/scenario/e2e/status_bar.rs"]).modules).toEqual(["status_bar"]);
    expect(modulesFor(["gpui/crates/lattice-gpui/src/scenario/e2e/pdf/navigation.rs"]).modules).toEqual(["pdf"]);
    expect(modulesFor(["gpui/crates/lattice-gpui/src/scenario/e2e/markdown_scroll.rs"]).modules).toEqual(["markdown"]);
  });

  it("picks modules from the app source they exercise", () => {
    expect(modulesFor(["gpui/crates/lattice-gpui/src/file_tree/naming.rs", "gpui/crates/lattice-gpui/src/submission.rs"]).modules).toEqual(["new_entries", "submission", "submission_checklist", "tree"]);
    expect(modulesFor(["gpui/crates/lattice-gpui/src/editor_panel/bib_view.rs"]).modules).toEqual(["bib"]);
  });

  it("picks the dock steps from the layout code", () => {
    expect(modulesFor(["gpui/crates/trellis/src/lib.rs", "gpui/crates/lattice-gpui/src/scenario/shell_steps.rs"]).modules).toEqual(["dock"]);
  });

  it("picks none for shared files and nothing GPUI for the rest", () => {
    expect(modulesFor(["gpui/crates/lattice-gpui/src/shell.rs", "gpui/Cargo.lock"])).toMatchObject({ gpui: true, modules: [] });
    expect(modulesFor(["src/App.tsx"])).toMatchObject({ gpui: false, modules: [] });
  });

  it("reads every module the scenario registers, and only those", () => {
    // A sample, not the whole list, so a new module does not edit this test:
    // a plain file, a folder's `mod.rs`, a macOS-only one and the wrapped dock.
    expect(MODULES).toEqual(expect.arrayContaining(["assets", "pdf", "overleaf", "islands", "dock"]));
    expect(MODULES).toEqual([...MODULES].sort());
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
