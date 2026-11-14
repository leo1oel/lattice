import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODULES, modulesFor } from "./gpui-e2e-modules.mjs";

const scenario = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../gpui/crates/lattice-gpui/src/scenario");

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

  it("knows every module the scenario gates, and only those", () => {
    const gated = [...readFileSync(path.join(scenario, "e2e.rs"), "utf8").matchAll(/steps::selected\("(\w+)"\)/g)].map((match) => match[1]);
    expect([...gated].sort()).toEqual([...MODULES].sort());
    const files = readdirSync(path.join(scenario, "e2e")).map((name) => name.replace(/\.rs$/, ""));
    for (const module of MODULES.filter((name) => name !== "dock")) expect(files).toContain(module);
    const listed = [...readFileSync(path.join(scenario, "e2e", "steps.rs"), "utf8").matchAll(/^ {4}\("(\w+)", &\[/gm)].map((match) => match[1]);
    expect([...listed].sort()).toEqual([...MODULES].sort());
  });
});
