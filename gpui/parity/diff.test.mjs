// node --test gpui/parity/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { familyKey, groundColor } from "./diff.mjs";
import { blankImage } from "./png.mjs";

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
