// The parity report: report.md (and the same tables in index.html) over every
// screen and theme the run diffed, beside report.json.

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

function textCell(row) {
  if (!row.text) return "";
  if (row.text.missing) return `✗ no label in ${row.text.missing}`;
  const off = Object.entries(row.text.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k} ${typeof c.ref === "number" ? num(c.ref) : c.ref} → ${typeof c.gpui === "number" ? num(c.gpui) : c.gpui}`);
  return `${mark(row.text)} ${off.join("; ")}`;
}

const chromeCell = (row) => (!row.chrome ? "" : `${mark(row.chrome)} ${row.chrome.ref} → ${row.chrome.gpui} (ΔE ${num(row.chrome.deltaE)})`);

function screenMarkdown(report, prefix) {
  const s = report.summary;
  const lines = [
    `## ${report.screen} · ${report.theme}`,
    "",
    `${report.viewport.width}×${report.viewport.height} @${report.scale}x · UI font ${report.uiFont} · PDF: ${report.pdf}`,
    "",
    `![${report.screen} ${report.theme}: reference, GPUI, heatmap](${prefix}-side-by-side.png)`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Region bounds (±${report.tolerance.bounds} px) | ${s.bounds.passed} / ${s.bounds.total} |`,
    `| Label text (family, size, weight, line height) | ${s.text.passed} / ${s.text.total} |`,
    `| Chrome colours (ΔE2000 ≤ ${report.tolerance.chrome}) | ${s.chrome.passed} / ${s.chrome.total} |`,
    s.pixels
      ? `| Pixels differing outside text and content | ${pct(s.pixels.rate)} (budget ${pct(s.pixels.budget)}, run-to-run noise ${pct(s.pixels.noiseRate)}) ${s.pixels.pass ? "✓" : "✗"} |`
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
    "In each image: reference | GPUI | heatmap. On the heatmap, red pixels differ (ΔE2000 > 2.3), amber changed between two runs of the same app, blue is text and hatching is content (the PDF pages); boxes are the regions, green in the reference and violet in GPUI.",
    "",
    ...screens.map(({ report, prefix }) => screenMarkdown(report, prefix)),
  ].join("\n");
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The markdown's tables and images as a page, without a Markdown library. */
export function htmlReport(markdown) {
  const body = [];
  let table = null;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("|")) {
      const cells = line.slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      if (!table) { table = []; body.push(table); }
      table.push(cells);
      continue;
    }
    table = null;
    const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
    if (line.startsWith("## ")) body.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    else if (line.startsWith("# ")) body.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    else if (image) body.push(`<a href="${image[2]}"><img src="${image[2]}" alt="${escapeHtml(image[1])}"></a>`);
    else if (line.trim()) body.push(`<p>${escapeHtml(line).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`);
  }
  const html = body.map((part) => (Array.isArray(part)
    ? `<table>${part.map((cells, i) => `<tr>${cells.map((c) => (i ? `<td>${escapeHtml(c)}</td>` : `<th>${escapeHtml(c)}</th>`)).join("")}</tr>`).join("")}</table>`
    : part)).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>GPUI parity report</title>
<style>body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:24px;color:#1c1c1f}img{max-width:100%;border:1px solid #ddd}
table{border-collapse:collapse;margin:8px 0 20px}td,th{border:1px solid #e3e3e3;padding:3px 8px;text-align:left;font-variant-numeric:tabular-nums}th{background:#f4f4f5}</style>
${html}`;
}
