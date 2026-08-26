import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESENTATION_THEMES, PRESENTATION_TRANSITIONS } from "./presentation-model";

const skill = readFileSync(
  "src-tauri/src/embedded_skills/authoring-presentations/SKILL.md",
  "utf8",
);

function documentedValues(label: string): string[] {
  const sentence = new RegExp(`The supported ${label} are exactly ([^\\n]+)\\.`).exec(skill)?.[1] ?? "";
  return [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

describe("bundled presentation authoring skill", () => {
  it("is discoverable with the expected Agent Skill metadata", () => {
    expect(skill).toMatch(/^---\nname: authoring-presentations\n/);
    expect(skill).toContain("display-name: Presentation Authoring");
    expect(skill).toContain("description: Creates and edits Lattice Reveal.js presentations");
  });

  it("documents the presentation dialect without drifting from the parser", () => {
    expect(documentedValues("themes")).toEqual([...PRESENTATION_THEMES]);
    expect(documentedValues("transitions")).toEqual([...PRESENTATION_TRANSITIONS]);
    expect(skill).toContain("line containing only `---`");
    expect(skill).toContain("line containing exactly `Notes:`");
    expect(skill).toContain("https://github.com/hakimel/reveal.js");
  });
});
