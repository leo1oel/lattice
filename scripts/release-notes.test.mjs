import { describe, expect, it } from "vitest";
import { parseReleaseLead, releaseNotes } from "./release-notes.mjs";

const lead = `## Highlights since 0.7.0

- **A much smaller app.** About 310 MB installed, \`/mcp\` included.
- **Synara 1.0.5 in the Agent panel.**

Some prose the sheet does not show.

## Notable fixes

- The \`.bib\` list draws its first rows again.
`;

describe("release notes from a lead", () => {
  it("reads each highlight's bold title and its body, and each fix, as plain text", () => {
    expect(parseReleaseLead(lead)).toEqual({
      highlights: [
        { title: "A much smaller app", body: "About 310 MB installed, /mcp included." },
        { title: "Synara 1.0.5 in the Agent panel", body: "" },
      ],
      fixes: ["The .bib list draws its first rows again."],
    });
  });

  it("keeps the Chinese and the icon of every unchanged text, and leaves new ones to translate", () => {
    const previous = {
      highlights: [{ icon: "feather", title: { en: "A much smaller app", zh: "安装包小了一半" }, body: { en: "Older wording.", zh: "旧的说法。" } }],
      fixes: [{ en: "The .bib list draws its first rows again.", zh: ".bib 列表恢复正常。" }],
    };
    const notes = releaseNotes("0.8.0", "2026-10-16", parseReleaseLead(lead), previous);
    expect(notes.highlights[0]).toEqual({
      icon: "feather",
      title: { en: "A much smaller app", zh: "安装包小了一半" },
      body: { en: "About 310 MB installed, /mcp included.", zh: "" },
    });
    expect(notes.highlights[1]).toEqual({ title: { en: "Synara 1.0.5 in the Agent panel", zh: "" } });
    expect(notes.fixes).toEqual([{ en: "The .bib list draws its first rows again.", zh: ".bib 列表恢复正常。" }]);
  });
});
