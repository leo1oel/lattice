// node --test gpui/parity/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { deltaE, deltaE2000, hex } from "./color.mjs";
import { blankImage, decodePng, encodePng } from "./png.mjs";

// Sharma, Wu and Dalal's test data (Table 1), a few pairs from each region of the formula.
const SHARMA = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

test("CIEDE2000 matches Sharma's reference pairs", () => {
  for (const [a, b, expected] of SHARMA) assert.ok(Math.abs(deltaE2000(a, b) - expected) < 1e-4, `${a} ${b}`);
});

test("sRGB colours that differ by one step are well inside ΔE 1", () => {
  assert.equal(deltaE([240, 240, 241], [240, 240, 241]), 0);
  assert.ok(deltaE([240, 240, 241], [241, 240, 241]) < 1);
  assert.ok(deltaE([240, 240, 241], [219, 219, 220]) > 1);
  assert.equal(hex([219, 219, 220]), "#DBDBDC");
});

// A 4×4 image, one row per filter, as PNG bytes encoded from the PNG spec
// outside this module and checked against PIXELS by Pillow and ImageMagick.
// Row 1's Paeth row hits both of the predictor's ties (pb = pc < pa picks b,
// pa = pc < pb picks a), and row 2's Average sums past 255.
const PIXELS = [
  [[10, 10, 200, 255], [30, 0, 201, 128], [250, 5, 7, 0], [128, 64, 32, 200]],
  [[0, 30, 201, 10], [77, 99, 180, 255], [255, 255, 255, 255], [1, 2, 3, 4]],
  [[200, 150, 100, 50], [201, 151, 101, 51], [0, 0, 0, 0], [99, 199, 249, 149]],
  [[5, 250, 128, 0], [255, 0, 1, 2], [3, 3, 3, 3], [100, 100, 100, 100]],
];
// Colour type 6, rows filtered Sub, Paeth, Average, Up.
const RGBA_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAATUlEQVR42mPk4jrxX+QbY+MdVruGNmvJEyzfRBi59V1ff2Wd86O+kZmFlflEO4OuvfTN2TKmfunJx35MZrJNkTlnljnnPDMQMM7NPg8AbMQZP1XfnlkAAAAASUVORK5CYII=";
// Colour type 2 (the same pixels without alpha), rows filtered Up, Sub, Paeth, Average.
const RGB_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAO0lEQVR42mPi4johx3DyFyt7g4MCI4PcSV/X15vmeDMxs7CcqJjNCAI+ycd/Mi9c7zfDor+Fmdnw/zMAonYRpjxkRoIAAAAASUVORK5CYII=";

test("PNGs written with every filter, in RGB and RGBA, decode to their pixels", () => {
  const rgba = decodePng(Buffer.from(RGBA_PNG, "base64"));
  assert.equal(rgba.width, 4);
  assert.equal(rgba.height, 4);
  assert.deepEqual([...rgba.data], PIXELS.flat(2));
  const rgb = decodePng(Buffer.from(RGB_PNG, "base64"));
  assert.deepEqual([...rgb.data], PIXELS.flat().flatMap(([r, g, b]) => [r, g, b, 255]));
});

test("PNG round trip", () => {
  const image = blankImage(3, 2);
  image.data.set([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const back = decodePng(encodePng(image));
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.data], [...image.data]);
});
