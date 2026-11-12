// node --test gpui/parity/*.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareTexts, diffScreen, familyKey, groundColor } from "./diff.mjs";
import { blankImage, writePng } from "./png.mjs";

test("families compare without their weight and style words", () => {
  // Chrome names the variable font's default instance; GPUI the family it asked for.
  assert.equal(familyKey("Timeless Sans Grotesk Light"), familyKey("Timeless Sans"));
  assert.equal(familyKey("Ioskeley Mono Medium"), familyKey("Ioskeley Mono"));
  assert.equal(familyKey("Inter Variable"), familyKey("Inter"));
  // The text and display cuts of the serif are different faces.
  assert.notEqual(familyKey("Timeless Serif Text"), familyKey("Timeless Serif"));
  assert.notEqual(familyKey("Inter"), familyKey("Ioskeley Mono"));
});

test("a region's ground is its most common colour, inside its edge", () => {
  // 20×10 device px at 2x: a 10×5 region, grey with a darker 1 px border and a black label.
  const image = blankImage(20, 10);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 20; x++) {
      const o = (y * 20 + x) * 4;
      const edge = x === 0 || y === 0 || x === 19 || y === 9;
      const label = y === 5 && x >= 6 && x < 12;
      const v = edge ? 100 : label ? 0 : 239;
      image.data.set([v, v, label ? 0 : v + 1, 255], o);
    }
  }
  assert.deepEqual(groundColor(image, { x: 0, y: 0, w: 10, h: 5 }, 2), [239, 239, 240]);
});

test("pixels that differ between the GPUI app's two runs still count against it", () => {
  // Two identical reference runs (no noise, so the 0.1% floor is the budget);
  // the GPUI app draws a 4×4 block differently in each run and unlike the reference.
  const dir = mkdtempSync(join(tmpdir(), "parity-diff-"));
  const image = (block) => {
    const out = blankImage(20, 20);
    for (let i = 0; i < 400; i++) {
      const inBlock = block != null && i % 20 >= 8 && i % 20 < 12 && Math.floor(i / 20) >= 8 && Math.floor(i / 20) < 12;
      const v = inBlock ? block : 200;
      out.data.set([v, v, v, 255], i * 4);
    }
    return out;
  };
  const files = { ref: image(null), ref2: image(null), gpui: image(0), gpui2: image(255) };
  for (const [name, img] of Object.entries(files)) writePng(join(dir, `${name}.png`), img);
  const ref = (name) => ({ pngPath: join(dir, `${name}.png`), scale: 1, regions: {}, textRects: [], contentRects: [], theme: "light", viewport: { width: 20, height: 20 } });
  const gpui = (name) => ({ png: join(dir, `${name}.png`), scale: 1, regions: {} });
  const { report } = diffScreen({ label: "test", regions: [] }, { ref: [ref("ref"), ref("ref2")], gpui: [gpui("gpui"), gpui("gpui2")] });
  const { pixels } = report.summary;
  assert.equal(pixels.noiseRate, 0);
  assert.equal(pixels.budget, 0.001);
  assert.equal(pixels.differing, 16);
  assert.equal(pixels.rate, 16 / 400);
  assert.equal(pixels.pass, false);
  assert.equal(pixels.gpuiNoiseRate, 16 / 400);
});

test("a region's runs of text pair by their text, then in order", () => {
  const look = (content, size = 12) => ({ content, family: "Timeless Sans", size, weight: 400, lineHeight: 16 });
  const runs = compareTexts(
    [look("This file ·"), look("1,204 words"), look("⌘K")],
    [look("1,204 words", 13), look("This file ·"), look("1204 words"), look("Extra")],
  );
  // "This file ·" and "1,204 words" find their twins; "⌘K" takes the first run left over.
  assert.deepEqual(runs.map((r) => [r.ref, r.gpui, r.pass]), [
    ["This file ·", "This file ·", true],
    ["1,204 words", "1,204 words", false],
    ["⌘K", "1204 words", true],
    [undefined, "Extra", false],
  ]);
  assert.equal(runs[1].checks.size.pass, false);
  assert.equal(runs[3].missing, "reference");
  assert.equal(compareTexts([look("Saved"), look("Build")], [look("Saved")])[1].missing, "gpui");
  // The editor's one style, with no content, is checked against every run on the line.
  const editor = compareTexts([look("\\section"), look("{Intro}")], [{ ...look(null), content: null }]);
  assert.deepEqual(editor.map((r) => r.pass), [true, true]);
});
