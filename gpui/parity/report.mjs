// The parity report: report.md over every screen and theme the run diffed,
// beside report.json.

const pct = (v) => (v == null ? "–" : `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`);
const num = (v) => (v == null ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ""));
const mark = (check) => (!check ? "" : check.pass ? "✓" : "✗");
const signed = (v) => (v > 0 ? `+${num(v)}` : num(v));

function boundsCell(row) {
  if (row.missing) return `not in ${row.missing === "gpui" ? "GPUI" : "reference"}`;
  if (!row.bounds) return "";
  const { delta } = row.bounds;
  const moved = Object.entries(delta).filter(([, v]) => Math.abs(v) > 0.05).map(([k, v]) => `${k}${signed(v)}`);
  return `${mark(row.bounds)} ${moved.join(" ") || "exact"}`;
}

const value = (v) => (typeof v === "number" ? num(v) : v);
const SIDE = { gpui: "GPUI", reference: "the reference" };

function runCell(run) {
  if (run.missing === "both") return "no text on either side";
  if (run.missing) return `“${run.ref ?? run.gpui}” not in ${SIDE[run.missing]}`;
  const label = run.gpui == null || run.ref === run.gpui ? `“${run.ref}”` : `“${run.ref}” (GPUI “${run.gpui}”)`;
  const off = Object.entries(run.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k} ${value(c.ref)} → ${value(c.gpui)}`);
  return `${label}: ${off.join(", ")}`;
}

function textCell(row) {
  if (!row.text) return "";
  const failing = row.text.runs.filter((run) => !run.pass);
  const passed = row.text.runs.length - failing.length;
  return `${mark(row.text)} ${passed} / ${row.text.runs.length} runs${failing.length ? `; ${failing.map(runCell).join("; ")}` : ""}`;
}

const chromeCell = (row) => (!row.chrome ? "" : `${mark(row.chrome)} ${row.chrome.ref} → ${row.chrome.gpui} (ΔE ${num(row.chrome.deltaE)})`);

function screenMarkdown(report, prefix) {
  const s = report.summary;
  const lines = [
    `## ${report.screen} · ${report.theme}`,
    "",
    `${report.viewport.width}×${report.viewport.height} @${report.scale}x · UI font ${report.uiFont} · PDF: the tutorial, as the web demo ships it`,
    "",
    `![${report.screen} ${report.theme}: reference, GPUI, heatmap](${prefix}-side-by-side.png)`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Region bounds (±${report.tolerance.bounds} px) | ${s.bounds.passed} / ${s.bounds.total} |`,
    `| Text runs (family, size, weight, line height) | ${s.text.passed} / ${s.text.total} |`,
    `| Chrome colours (ΔE2000 ≤ ${report.tolerance.chrome}) | ${s.chrome.passed} / ${s.chrome.total} |`,
    s.pixels
      ? `| Pixels differing outside text and content | ${pct(s.pixels.rate)} (budget ${pct(s.pixels.budget)}, the reference's run-to-run noise ${pct(s.pixels.noiseRate)}) ${s.pixels.pass ? "✓" : "✗"} |\n`
        + `| GPUI run-to-run instability (kept in the comparison) | ${pct(s.pixels.gpuiNoiseRate)} |`
      : `| Pixels | not compared: the captures differ in size (${Object.entries(s.sizes).map(([k, v]) => `${k} ${v}`).join(", ")}) |`,
    `| Regions on one side only | ${s.missing.length ? s.missing.join(", ") : "none"} |`,
    "",
    "| Region | Bounds Δ (px) | Text | Chrome | Pixels off |",
    "| --- | --- | --- | --- | --- |",
    ...report.regions.map((row) => `| ${row.name} | ${boundsCell(row)} | ${textCell(row)} | ${chromeCell(row)} | ${pct(row.pixels)} |`),
    "",
  ];
  if (report.unmatchedGpuiRegions.length) lines.push(`GPUI regions with no reference counterpart: ${report.unmatchedGpuiRegions.join(", ")}.`, "");
  return lines.join("\n");
}

export function markdownReport(screens, meta) {
  return [
    "# GPUI parity report",
    "",
    `${meta.date} · GPUI app ${meta.app} · reference ${meta.benchUrl.split("?")[0]}`,
    "",
    "Reference: the Tauri frontend on the mock-backend page, staged by `design-system/screens/scenes.mjs`. GPUI: `lattice-gpui --scenario parity`.",
    "In each image: reference | GPUI | heatmap. On the heatmap, red pixels differ (ΔE2000 > 2.3), amber changed between the reference's two runs, blue is text and hatching is content (the PDF pages); boxes are the regions, green in the reference and violet in GPUI.",
    "",
    ...screens.map(({ report, prefix }) => screenMarkdown(report, prefix)),
  ].join("\n");
}
