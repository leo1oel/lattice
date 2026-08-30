import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(
  "src-tauri/src/embedded_skills/authoring-presentations/SKILL.md",
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
});
