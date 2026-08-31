import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(
  "src-tauri/src/embedded_skills/authoring-presentations/SKILL.md",
  "utf8",
);
const createThemeSkill = readFileSync(
  "src-tauri/src/embedded_skills/create-theme/SKILL.md",
  "utf8",
);

describe("bundled Open Slide authoring skill", () => {
  it("is discoverable for presentation requests", () => {
    expect(skill).toMatch(/^---\nname: authoring-presentations\n/);
    expect(skill).toContain("display-name: Presentation Authoring");
    expect(skill).toContain("Open Slide presentations");
    expect(skill).toContain("PPTX, PowerPoint, 演示文稿, or 幻灯片");
  });

  it("defines the native deck contract and removes the legacy format", () => {
    expect(skill).toContain("slides/<deck-id>/index.tsx");
    expect(skill).toContain("export default [Cover] satisfies Page[]");
    expect(skill).toContain("export const notes = [");
    expect(skill).toContain("1920 × 1080");
    expect(skill).toContain('display: \'"Inter Variable", Inter');
    expect(skill).toContain('body: \'"Inter Variable", Inter');
    expect(skill).toContain("import katex from 'katex'");
    expect(skill).toContain("katex.renderToString");
    expect(skill).toContain("throwOnError: false");
  });

  it("preserves existing asset scopes when embedding HTML", () => {
    expect(skill).toContain("preserve every existing asset's location and import specifier");
    expect(skill).toContain("rewrite unrelated `@assets/...` imports to `./assets/...`");
    expect(skill).toContain("import only that HTML file with `?raw`");
    expect(skill).toContain("leave existing image and media imports unchanged");
  });

  it("applies bundled themes when authoring a new deck", () => {
    expect(skill).toContain("inspect markdown files under `themes/`");
    expect(skill).toContain("read its markdown end to end");
    expect(skill).toContain("set `meta.theme` to the theme id");
    expect(skill).toContain("does not inherit later theme edits automatically");
  });
});

describe("bundled Open Slide theme creation skill", () => {
  it("is discoverable as create-theme in the AI command menu", () => {
    expect(createThemeSkill).toMatch(/^---\nname: create-theme\n/);
    expect(createThemeSkill).toContain("display-name: Create Theme");
    expect(createThemeSkill).toContain("invokes /create-theme");
  });

  it("creates the paired theme contract without changing real decks", () => {
    expect(createThemeSkill).toContain("themes/<id>.md");
    expect(createThemeSkill).toContain("themes/<id>.demo.tsx");
    expect(createThemeSkill).toContain("export default [Cover, Content] satisfies Page[]");
    expect(createThemeSkill).toContain("do not modify them");
    expect(createThemeSkill).toContain("Do not modify `slides/`");
  });
});
