import { describe, expect, it } from "vitest";
import { buildVisualMarkdownBlockModel } from "./visual-markdown-block-model";

describe("buildVisualMarkdownBlockModel", () => {
  it("owns exact block slices while preserving every gap and envelope byte", () => {
    const markdown = "\uFEFF# Title\r\n\r\nParagraph with $x$.\r\n\r\n- one\r\n- two\r\n";
    const model = buildVisualMarkdownBlockModel(markdown);

    expect(model).not.toBeNull();
    expect(model?.sourceOffsetBase).toBe(1);
    expect(model?.blocks.map((block) => block.source)).toEqual([
      "# Title",
      "Paragraph with $x$.",
      "- one\r\n- two",
    ]);
    expect(model?.leading).toBe("");
    expect(model?.gaps).toEqual(["\r\n\r\n", "\r\n\r\n"]);
    expect(model?.trailing).toBe("\r\n");
    expect(`\uFEFF${model?.blocks.reduce((result, block, index) => (
      result + (index === 0 ? model.leading : model.gaps[index - 1]) + block.source
    ), "")}${model?.trailing}`).toBe(markdown);
  });

  it("gives duplicate blocks distinct session identities", () => {
    const model = buildVisualMarkdownBlockModel("same\n\nsame\n\nsame\n");

    expect(model?.blocks.map((block) => block.id)).toHaveLength(3);
    expect(new Set(model?.blocks.map((block) => block.id)).size).toBe(3);
  });

  it("refuses source shapes whose root ownership is not exact", () => {
    expect(buildVisualMarkdownBlockModel(
      "<!-- c -->\n\n[^n]: First paragraph.\n\n  Not a continuation.\n",
    )).toBeNull();
  });

  it("falls back when one root would defeat the mounted-window bound", () => {
    const giantList = Array.from({ length: 900 }, (_, index) => `- item ${index}`).join("\n");

    expect(buildVisualMarkdownBlockModel(`# Title\n\n${giantList}\n`)).toBeNull();
  });
});
