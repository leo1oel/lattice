// The parity diff for one screen in one theme: two reference runs and two
// GPUI runs in, a verdict per check and the images out.
//
//   bounds  each named region within ±1 px (logical) of the reference
//   text    each label's family, size, weight and line height
//   chrome  each chrome region's ground colour within ΔE2000 1
//   pixels  the share of pixels that differ visibly (ΔE2000 > 2.3), outside
//           text (every reference text run's box, 2 px wider), outside the
//           content regions (the PDF pages, drawn by pdf.js and PDFium), and
//           outside what changed between two runs of the same app, within a
//           budget of three times that run-to-run noise (at least 0.1%)
//
// Families are compared without their weight and width words: Chrome names
// the face it drew ("Timeless Sans Grotesk Light", the variable font's
// default instance), GPUI the family it asked for ("Timeless Sans").
import { deltaE, hex } from "./color.mjs";
import { blankImage, readPng, writePng } from "./png.mjs";

export const TOLERANCE = { bounds: 1, size: 0.25, weight: 1, lineHeight: 0.5, chrome: 1, pixel: 2.3, textPad: 2 };
const BUDGET_FLOOR = 0.001;
const BUDGET_NOISE_FACTOR = 3;

const FACE_WORDS = /\b(thin|hairline|extra ?light|ultra ?light|light|book|regular|normal|medium|semi ?bold|demi ?bold|bold|extra ?bold|ultra ?bold|black|heavy|italic|oblique|variable|vf|grotesk)\b/gi;
export const familyKey = (name) => (name ?? "").replace(FACE_WORDS, "").replace(/[\s_-]+/g, "").toLowerCase();

/** The most common colour inside `b` (logical px, inset 2 px), as [r, g, b]. */
export function groundColor(image, b, scale) {
  const x0 = Math.max(0, Math.round((b.x + 2) * scale)), y0 = Math.max(0, Math.round((b.y + 2) * scale));
  const x1 = Math.min(image.width, Math.round((b.x + b.w - 2) * scale)), y1 = Math.min(image.height, Math.round((b.y + b.h - 2) * scale));
  const counts = new Map();
  let best = null, bestCount = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      const key = (image.data[o] << 16) | (image.data[o + 1] << 8) | image.data[o + 2];
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > bestCount) { bestCount = count; best = key; }
    }
  }
  return best === null ? null : [best >> 16, (best >> 8) & 0xff, best & 0xff];
}

const rgbAt = (image, i) => [image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]];

/** Per-pixel ΔE2000 of two same-sized images, with identical pixels skipped. */
function pixelDelta(a, b) {
  const out = new Float32Array(a.width * a.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    if (a.data[o] === b.data[o] && a.data[o + 1] === b.data[o + 1] && a.data[o + 2] === b.data[o + 2]) continue;
    out[i] = deltaE(rgbAt(a, i), rgbAt(b, i));
  }
  return out;
}

/** A mask (1 per device pixel) of rectangles given in logical px, grown by `pad`. */
function rectMask(width, height, rects, scale, pad = 0) {
  const mask = new Uint8Array(width * height);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.x - pad) * scale)), y0 = Math.max(0, Math.floor((r.y - pad) * scale));
    const x1 = Math.min(width, Math.ceil((r.x + r.w + pad) * scale)), y1 = Math.min(height, Math.ceil((r.y + r.h + pad) * scale));
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
  return mask;
}

/** Grow a mask by `radius` device pixels (a square neighbourhood). */
function dilate(mask, width, height, radius) {
  if (radius <= 0) return mask;
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      rows.fill(1, y * width + Math.max(0, x - radius), y * width + Math.min(width, x + radius + 1));
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!rows[y * width + x]) continue;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) out[yy * width + x] = 1;
    }
  }
  return out;
}

function compareBounds(ref, gpui) {
  const d = { x: gpui.x - ref.x, y: gpui.y - ref.y, w: gpui.w - ref.w, h: gpui.h - ref.h };
  const worst = Math.max(...Object.values(d).map(Math.abs));
  return { pass: worst <= TOLERANCE.bounds, delta: d, worst };
}

function compareText(ref, gpui) {
  const checks = {
    family: { ref: ref.family ?? ref.stack, gpui: gpui.family, pass: familyKey(ref.family) === familyKey(gpui.family) },
    size: { ref: ref.size, gpui: gpui.size, pass: Math.abs(ref.size - gpui.size) <= TOLERANCE.size },
    weight: { ref: ref.weight, gpui: gpui.weight, pass: Math.abs(ref.weight - gpui.weight) <= TOLERANCE.weight },
    lineHeight: { ref: ref.lineHeight, gpui: gpui.lineHeight, pass: ref.lineHeight != null && Math.abs(ref.lineHeight - gpui.lineHeight) <= TOLERANCE.lineHeight },
  };
  return { pass: Object.values(checks).every((c) => c.pass), checks };
}

/**
 * runs: { ref: [record, record], gpui: [result, result] }, each with a `png`
 * path (the reference records' is `pngPath`). Returns the report object and
 * the images: { report, images: { sideBySide, heatmap } }.
 */
export function diffScreen(spec, runs) {
  const [ref, ref2] = runs.ref;
  const [gpui, gpui2] = runs.gpui;
  const scale = ref.scale;
  const images = { ref: readPng(ref.pngPath), ref2: readPng(ref2.pngPath), gpui: readPng(gpui.png), gpui2: readPng(gpui2.png) };
  const regions = [];
  for (const r of spec.regions) {
    const a = ref.regions[r.name];
    const b = gpui.regions[r.name];
    const row = { name: r.name, ref: a?.bounds ?? null, gpui: b?.bounds ?? null };
    if (!a) row.missing = "reference";
    else if (!b) row.missing = "gpui";
    if (!row.missing) {
      if (r.bounds !== false && a.bounds && b.bounds) row.bounds = compareBounds(a.bounds, b.bounds);
      if (r.text) row.text = a.text && b.text ? compareText(a.text, b.text) : { pass: false, missing: !a.text ? "reference" : "gpui" };
      if (r.chrome && a.bounds && b.bounds) {
        const ca = groundColor(images.ref, a.bounds, scale);
        const cb = groundColor(images.gpui, b.bounds, gpui.scale);
        const de = ca && cb ? deltaE(ca, cb) : Infinity;
        row.chrome = { ref: ca && hex(ca), gpui: cb && hex(cb), deltaE: de, pass: de <= TOLERANCE.chrome };
      }
    }
    regions.push(row);
  }
  const extra = Object.keys(gpui.regions).filter((name) => !spec.regions.some((r) => r.name === name));

  const sameSize = ["ref2", "gpui", "gpui2"].every((k) => images[k].width === images.ref.width && images[k].height === images.ref.height);
  let pixels = null, heat = null;
  if (sameSize) {
    const { width, height } = images.ref;
    const refNoise = pixelDelta(images.ref, images.ref2);
    const gpuiNoise = pixelDelta(images.gpui, images.gpui2);
    const delta = pixelDelta(images.ref, images.gpui);
    const textMask = rectMask(width, height, ref.textRects, scale, TOLERANCE.textPad);
    const contentMask = rectMask(width, height, ref.contentRects, scale);
    const noisy = new Uint8Array(width * height);
    for (let i = 0; i < noisy.length; i++) noisy[i] = refNoise[i] > TOLERANCE.pixel || gpuiNoise[i] > TOLERANCE.pixel ? 1 : 0;
    const noiseMask = dilate(noisy, width, height, 1);
    let compared = 0, differing = 0, noise = 0;
    for (let i = 0; i < delta.length; i++) {
      if (textMask[i] || contentMask[i]) continue;
      if (noisy[i]) noise++;
      if (noiseMask[i]) continue;
      compared++;
      if (delta[i] > TOLERANCE.pixel) differing++;
    }
    const area = compared + noise;
    const noiseRate = area ? noise / area : 0;
    const budget = Math.max(BUDGET_FLOOR, BUDGET_NOISE_FACTOR * noiseRate);
    const rate = compared ? differing / compared : 0;
    pixels = { compared, differing, rate, noiseRate, budget, pass: rate <= budget };
    // Where inside each region the pixels differ.
    for (const row of regions) {
      if (!row.ref) continue;
      const m = rectMask(width, height, [row.ref], scale);
      let n = 0, d = 0;
      for (let i = 0; i < m.length; i++) {
        if (!m[i] || textMask[i] || contentMask[i] || noiseMask[i]) continue;
        n++;
        if (delta[i] > TOLERANCE.pixel) d++;
      }
      row.pixels = n ? d / n : null;
    }
    heat = heatmap(images.ref, delta, { textMask, contentMask, noiseMask });
    outline(heat, regions, scale);
  }
  const verdict = (key) => {
    const rows = regions.filter((r) => r[key]);
    return { passed: rows.filter((r) => r[key].pass).length, total: rows.length };
  };
  const report = {
    screen: spec.label,
    theme: ref.theme,
    viewport: ref.viewport,
    scale,
    pdf: ref.pdf,
    uiFont: gpui.uiFont,
    summary: {
      bounds: verdict("bounds"), text: verdict("text"), chrome: verdict("chrome"),
      missing: regions.filter((r) => r.missing).map((r) => `${r.name} (not in ${r.missing === "gpui" ? "the GPUI app" : "the reference"})`),
      pixels,
      sizes: sameSize ? null : Object.fromEntries(Object.entries(images).map(([k, v]) => [k, `${v.width}×${v.height}`])),
    },
    regions,
    unmatchedGpuiRegions: extra,
    tolerance: TOLERANCE,
  };
  return { report, images: { sideBySide: sideBySide(images.ref, images.gpui, heat, scale), heatmap: heat } };
}

/** The reference greyed out, with differing pixels in red (by how far apart), noise in amber, text in blue, content hatched. */
function heatmap(ref, delta, { textMask, contentMask, noiseMask }) {
  const out = blankImage(ref.width, ref.height);
  for (let i = 0; i < delta.length; i++) {
    const o = i * 4;
    const lum = 0.2126 * ref.data[o] + 0.7152 * ref.data[o + 1] + 0.0722 * ref.data[o + 2];
    let r = 200 + lum * 0.2, g = r, b = r;
    const x = i % ref.width, y = (i / ref.width) | 0;
    if (contentMask[i]) { if ((x + y) % 12 < 2) { r = g = b = 170; } }
    else if (textMask[i]) { r -= 30; g -= 15; b += 10; }
    if (!contentMask[i] && !textMask[i]) {
      if (noiseMask[i]) { r = 245; g = 190; b = 60; }
      else if (delta[i] > TOLERANCE.pixel) {
        const t = Math.min(1, 0.35 + delta[i] / 30);
        r = r * (1 - t) + 225 * t; g = g * (1 - t) + 20 * t; b = b * (1 - t) + 40 * t;
      }
    }
    out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = 255;
  }
  return out;
}

/** Each region's box drawn on the heatmap: the reference's in green, the GPUI app's in violet. */
function outline(image, regions, scale) {
  const line = (b, [r, g, bl]) => {
    const x0 = Math.round(b.x * scale), y0 = Math.round(b.y * scale);
    const x1 = Math.round((b.x + b.w) * scale) - 1, y1 = Math.round((b.y + b.h) * scale) - 1;
    const put = (x, y) => {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
      const o = (y * image.width + x) * 4;
      image.data[o] = r; image.data[o + 1] = g; image.data[o + 2] = bl;
    };
    for (let x = x0; x <= x1; x++) { put(x, y0); put(x, y1); }
    for (let y = y0; y <= y1; y++) { put(x0, y); put(x1, y); }
  };
  for (const row of regions) {
    if (row.ref) line(row.ref, [20, 150, 60]);
    if (row.gpui) line(row.gpui, [130, 60, 220]);
  }
}

/** Reference | GPUI | heatmap, at 1× (box-averaged from the device scale), 16 px apart. */
function sideBySide(ref, gpui, heat, scale) {
  const s = Math.max(1, Math.round(scale));
  const panels = [ref, gpui, heat].filter(Boolean);
  const w = Math.floor(ref.width / s), h = Math.floor(ref.height / s), gap = 16;
  const out = blankImage(w * panels.length + gap * (panels.length - 1), h);
  out.data.fill(255);
  panels.forEach((image, p) => {
    const ox = p * (w + gap);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
          const sx = x * s + dx, sy = y * s + dy;
          if (sx >= image.width || sy >= image.height) continue;
          const o = (sy * image.width + sx) * 4;
          r += image.data[o]; g += image.data[o + 1]; b += image.data[o + 2]; n++;
        }
        const o = (y * out.width + ox + x) * 4;
        out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
      }
    }
  });
  return out;
}

export function writeImages(images, prefix) {
  writePng(`${prefix}-side-by-side.png`, images.sideBySide);
  if (images.heatmap) writePng(`${prefix}-heatmap.png`, images.heatmap);
}
