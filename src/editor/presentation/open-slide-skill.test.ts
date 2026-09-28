import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSkill = (name: string) => readFileSync(`src-tauri/src/embedded_skills/${name}/SKILL.md`, "utf8");

describe.each([
  ["authoring-presentations", {
    "is discoverable for presentation requests": [
      /^---\nname: authoring-presentations\n/,
      "display-name: Presentation Authoring",
      "Open Slide presentations",
      "PPTX, PowerPoint, 演示文稿, or 幻灯片",
    ],
    "defines the native deck contract and removes the legacy format": [
      "slides/<deck-id>/index.tsx",
      "export default [Cover] satisfies Page[]",
      "export const notes = [",
      "1920 × 1080",
      'display: \'"Inter Variable", Inter',
      'body: \'"Inter Variable", Inter',
      "import katex from 'katex'",
      "katex.renderToString",
      "throwOnError: false",
    ],
    "preserves existing asset scopes when embedding HTML": [
      "preserve every existing asset's location and import specifier",
      "rewrite unrelated `@assets/...` imports to `./assets/...`",
      "import only that HTML file with `?raw`",
      "leave existing image and media imports unchanged",
    ],
    "applies bundled themes when authoring a new deck": [
      "inspect markdown files under `themes/`",
      "read its markdown end to end",
      "set `meta.theme` to the theme id",
      "does not inherit later theme edits automatically",
    ],
  }],
  ["create-theme", {
    "is discoverable as create-theme in the AI command menu": [
      /^---\nname: create-theme\n/,
      "display-name: Create Theme",
      "invokes /create-theme",
    ],
    "creates the paired theme contract without changing real decks": [
      "themes/<id>.md",
      "themes/<id>.demo.tsx",
      "export default [Cover, Content] satisfies Page[]",
      "do not modify them",
      "Do not modify `slides/`",
    ],
  }],
] as const)("bundled Open Slide %s skill", (name, expectations) => {
  const skill = readSkill(name);
  it.each(Object.entries(expectations))("%s", (_behavior, needles) => {
    for (const needle of needles) {
      if (typeof needle === "string") expect(skill).toContain(needle);
      else expect(skill).toMatch(needle);
    }
  });
});
