import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { version } from "../../package.json";
import type { ReleaseNotes } from "../app/whats-new";

// The What's new sheet shows these in the interface language, and
// bump-version.mjs writes the Chinese empty for the maintainer to fill.
const files = readdirSync("src/release-notes").filter((name) => name.endsWith(".json"));
const notes = files.map((name) => [name, JSON.parse(readFileSync(`src/release-notes/${name}`, "utf8")) as ReleaseNotes] as const);

describe("bundled release notes", () => {
  it.each(notes)("%s names its own version, a date, and Chinese for every text", (name, release) => {
    expect(name).toBe(`${release.version}.json`);
    expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const texts = [...release.highlights.flatMap((note) => [note.title, note.body ?? null]), ...release.fixes].filter((text) => text !== null);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.en.trim(), name).not.toBe("");
      expect(text.zh.trim(), `${name}: "${text.en}" needs its Chinese`).not.toBe("");
    }
  });

  it("include none newer than the version being built", () => {
    for (const [, release] of notes) {
      const [a, b] = [release.version, version].map((value) => value.split(".").map(Number));
      expect(a![0]! * 1e6 + a![1]! * 1e3 + a![2]!).toBeLessThanOrEqual(b![0]! * 1e6 + b![1]! * 1e3 + b![2]!);
    }
  });
});
