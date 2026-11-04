import { expect, it } from "vitest";
import { classifyExternalProjectDrop } from "../app-utils";

it("offers code and configuration drops to the existing text-source import flow", () => {
  expect(classifyExternalProjectDrop(["src/main.rs", "Cargo.toml", "scripts/run.SH", "config.json", "workflow.yaml", "styles.css", "module.mjs"])).toBe("source");
  expect(classifyExternalProjectDrop(["program.exe"])).toBe("unsupported");
});
