// Goldens for crates/core/tests/board_rough.rs from the real roughjs 4.6.4.
// usage: node gen.cjs <roughjs package dir> <out.json>
const rough = require(require("path").join(process.argv[2], "bundled/rough.cjs.js"));
const fs = require("fs");

const mulberry = (seed) => { let v = seed >>> 0; return () => { v += 0x6d2b79f5; let n = v; n = Math.imul(n ^ (n >>> 15), n | 1); n ^= n + Math.imul(n ^ (n >>> 7), n | 61); return ((n ^ (n >>> 14)) >>> 0) / 4294967296; }; };

const cases = [];
const add = (name, call, args, options) => cases.push({ name, call, args, options });

const fills = ["hachure", "cross-hatch", "zigzag", "zigzag-line", "dots", "dashed", "solid"];
for (const r of [0, 1, 2]) {
  add(`rectangle r${r}`, "rectangle", [10, 20, 120, 80], { seed: 1234, roughness: r });
  add(`ellipse r${r}`, "ellipse", [60, 40, 120, 80], { seed: 99, roughness: r, curveFitting: 1 });
  add(`line r${r}`, "line", [0, 0, 150, 40], { seed: 7, roughness: r });
  add(`curve r${r}`, "curve", [[[0, 0], [50, 30], [100, -10], [160, 40]]], { seed: 42, roughness: r });
  add(`path r${r}`, "path", ["M 12 0 L 88 0 Q 100 0, 100 12 L 100 48 Q 100 60, 88 60 L 12 60 Q 0 60, 0 48 L 0 12 Q 0 0, 12 0"], { seed: 5, roughness: r, preserveVertices: true });
  for (const f of fills.filter((f) => f !== "dots")) {
    add(`rectangle fill ${f} r${r}`, "rectangle", [0, 0, 100, 70], { seed: 321, roughness: r, fill: "#f00", fillStyle: f, fillWeight: 1, hachureGap: 8, strokeWidth: 2 });
  }
}
add("rectangle fill dots", "rectangle", [0, 0, 40, 24], { seed: 321, roughness: 1, fill: "#f00", fillStyle: "dots", fillWeight: 1, hachureGap: 8, strokeWidth: 2 });
add("ellipse fill dots", "ellipse", [20, 15, 40, 30], { seed: 11, roughness: 0, fill: "#0f0", fillStyle: "dots", fillWeight: 2, hachureGap: 8, curveFitting: 1 });
for (const f of fills.filter((f) => f !== "dots")) {
  add(`ellipse fill ${f}`, "ellipse", [30, 20, 60, 40], { seed: 11, roughness: 1, fill: "#0f0", fillStyle: f, fillWeight: 0.5, hachureGap: 6, curveFitting: 1 });
  add(`polygon fill ${f}`, "polygon", [[[0, 0], [50, 6], [36, 42], [6, 30]]], { seed: 77, roughness: 1, fill: "#00f", fillStyle: f });
  add(`curve fill ${f}`, "curve", [[[0, 0], [60, -20], [120, 30], [70, 90], [0, 0]]], { seed: 13, roughness: 1.5, fill: "#00f", fillStyle: f, fillWeight: 1, hachureGap: 8 });
  add(`path fill ${f}`, "path", ["M 5 5 L 45 5 C 50 5, 50 10, 50 15 L 50 40 Z M 15 15 L 30 15 L 30 30 Z"], { seed: 3, roughness: 1, fill: "#abc", fillStyle: f });
}
// line lengths across the roughness gain's ranges, overlays, options
add("line long", "line", [0, 0, 600, 100], { seed: 8, roughness: 2 });
add("line mid", "line", [0, 0, 300, 100], { seed: 8, roughness: 1, bowing: 2 });
add("line tiny", "line", [0, 0, 3, 4], { seed: 8, roughness: 1 });
add("line single stroke dashed", "line", [5, 5, 200, 5], { seed: 1, roughness: 1, disableMultiStroke: true, strokeWidth: 2.5, strokeLineDash: [8, 10] });
add("line preserve vertices", "line", [5, 5, 200, 80], { seed: 2, roughness: 2, preserveVertices: true });
add("linearPath", "linearPath", [[[0, 0], [40, 10], [90, -5], [130, 60]]], { seed: 21, roughness: 1 });
add("linearPath two", "linearPath", [[[0, 0], [40, 10]]], { seed: 21, roughness: 1 });
add("polygon", "polygon", [[[0, 0], [40, 10], [90, -5], [130, 60]]], { seed: 22, roughness: 2 });
add("curve two points", "curve", [[[0, 0], [100, 20]]], { seed: 23, roughness: 1 });
add("curve three points", "curve", [[[0, 0], [50, 50], [100, 0]]], { seed: 24, roughness: 1 });
add("curve one point", "curve", [[[10, 10]]], { seed: 25, roughness: 1 });
add("curve roughness 0 single", "curve", [[[0, 0], [30, 40], [80, 10], [120, 50]]], { seed: 26, roughness: 0, disableMultiStroke: true, preserveVertices: true });
add("circle", "circle", [0, 0, 30], { seed: 27, roughness: 0.5, disableMultiStroke: true });
add("ellipse big", "ellipse", [0, 0, 800, 300], { seed: 28, roughness: 1, curveFitting: 1 });
add("ellipse fitting", "ellipse", [0, 0, 80, 300], { seed: 29, roughness: 2 });
add("arc open", "arc", [50, 50, 100, 80, 0.3, 4, false], { seed: 30, roughness: 1 });
add("arc closed fill", "arc", [50, 50, 100, 80, -1, 2, true], { seed: 31, roughness: 1, fill: "#f00", fillStyle: "hachure" });
add("arc closed solid", "arc", [50, 50, 100, 80, 0, 3, true], { seed: 32, roughness: 1, fill: "#f00", fillStyle: "solid" });
add("path relative and arcs", "path", ["m10 10 h50 v20 a20 15 30 0 1 -30 25 s-20 10 -30 0 t10 -20 q5 -5 10 0 z"], { seed: 33, roughness: 1 });
add("path simplified", "path", ["M0 0 C 30 -30, 70 30, 100 0 L 100 50 L 0 50 Z"], { seed: 34, roughness: 1, simplification: 0.5, fill: "#000", fillStyle: "hachure" });
add("path elbow", "path", ["M 0 0 L 84 0 Q 100 0, 100 16 L 100 84 Q 100 100, 116 100 L 200 100"], { seed: 35, roughness: 1, preserveVertices: true });
add("path roughness 0 single", "path", ["M 0 0 L 84 0 Q 100 0, 100 16 L 100 100"], { seed: 36, roughness: 0, disableMultiStroke: true, disableMultiStrokeFill: true, preserveVertices: true });
add("rectangle seed 0 r0", "rectangle", [0, 0, 50, 50], { seed: 0, roughness: 0 });
add("rectangle sw4 fill", "rectangle", [0, 0, 300, 200], { seed: 37, roughness: 1, fill: "#f00", fillStyle: "cross-hatch", fillWeight: 2, hachureGap: 16, strokeWidth: 4.5, disableMultiStroke: true });
add("rectangle angle", "rectangle", [0, 0, 120, 90], { seed: 38, roughness: 1, fill: "#f00", hachureAngle: 30, hachureGap: 6 });
add("rectangle zigzag offset", "rectangle", [0, 0, 40, 30], { seed: 39, roughness: 1, fill: "#f00", fillStyle: "zigzag-line", zigzagOffset: 3, hachureGap: 6 });
add("rectangle dashed gaps", "rectangle", [0, 0, 60, 40], { seed: 40, roughness: 1, fill: "#f00", fillStyle: "dashed", dashOffset: 5, dashGap: 3, hachureGap: 6 });

const gen = rough.generator();
for (const c of cases) {
  Math.random = mulberry(c.options.seed || 0);
  const d = gen[c.call](...c.args, c.options);
  c.shape = d.shape;
  c.sets = d.sets.map((s) => ({ type: s.type, ops: s.ops.map((o) => [o.op, ...o.data.map((v) => Math.round(v * 1e8) / 1e8)]) }));
}
fs.writeFileSync(process.argv[3], JSON.stringify({ roughjs: "4.6.4", cases }));
console.log(cases.length, "cases");
