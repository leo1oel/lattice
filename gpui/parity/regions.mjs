// The named regions the parity diff compares, per screen: what each one is in
// the Tauri app's DOM, and which checks apply to it. The GPUI app records the
// same names with `lattice_ui::parity` probes (the titlebar, the dock's
// cards, strips and tabs, tree rows, the status bar, the build chip).
//
// A region is found by a CSS selector (`css`, searched through shadow roots,
// so the file tree's rows are found too), or as part of a panel's tab group
// (`group`: the card, the 40px strip or the tab of the panel whose tab reads
// that label). Checks:
//   bounds  its box within ±1 px (default on)
//   text    its label's family, size, weight and line height
//   chrome  its ground colour (the most common colour inside it) within ΔE2000 1

const group = (label) => [
  { name: `card/${label}`, group: label, part: "card", chrome: true },
  { name: `strip/${label}`, group: label, part: "strip" },
  { name: `tab/${label}`, group: label, part: "tab", text: true, chrome: true },
];

const row = (path, item = path) => ({ name: `row/${path}`, css: `[data-item-path="${item}"]`, text: true });

export const SCREENS = {
  mainWindow: {
    label: "Main window",
    regions: [
      { name: "titlebar", css: "header.titlebar", chrome: true },
      { name: "titlebar/project", css: "button.project-title", text: true },
      { name: "titlebar/panels", css: "button.trellis-titlebar-menu", text: true },
      { name: "titlebar/workspace", css: ".trellis-presets", text: true },
      { name: "titlebar/search", css: "button.trellis-titlebar-search", text: true, chrome: true },
      { name: "titlebar/tools", css: ".canvas-actions" },
      { name: "workspace", css: "main.workspace", chrome: true },
      ...group("Project"),
      ...group("Papers"),
      ...group("main.tex"),
      ...group("PDF"),
      row("figures", "figures/"),
      row("attention-demo.html"),
      row("main.tex"),
      row("references.bib"),
      { name: "pdf/toolbar", css: ".pdf-toolbar", chrome: true },
      { name: "build-chip", css: ".trellis-build-button", text: true, chrome: true },
      { name: "status-bar", css: ".editor-status-bar", chrome: true },
      { name: "status/position", css: ".status-goto", text: true },
      { name: "status/save", css: ".status-save", text: true },
      { name: "status/words", css: ".status-body-words", text: true },
      // Zed's editor in the GPUI app: its text style only, its box is not the same element.
      { name: "editor/text", css: ".cm-content .cm-line", text: true, bounds: false },
    ],
    // Drawn by different engines in the two apps (pdf.js and PDFium), so left out of the pixel budget.
    content: [".pdf-viewer-host"],
  },
};

/**
 * Runs in the page: tags each region's element with data-parity-region (and
 * its label's element with data-parity-text) and measures it. Returns
 * { regions: {name: {bounds, text}}, textRects, contentRects }; textRects are
 * every visible text run's boxes, contentRects the content regions' boxes,
 * which the pixel budget leaves out.
 */
export function measureInPage({ regions, content }) {
  const deepAll = (root, selector, out = []) => {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) deepAll(el.shadowRoot, selector, out);
    return out;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.01;
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const textNodes = (root) => {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { if (child.data.trim()) out.push(child); continue; }
        if (child.nodeType !== 1) continue;
        const cs = getComputedStyle(child);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (child.matches(".sr-only")) continue;
        walk(child);
        if (child.shadowRoot) walk(child.shadowRoot);
      }
    };
    walk(root);
    return out;
  };
  const tabFor = (label) => deepAll(document, ".trellis [role=tablist] [role=tab]").find((tab) => tab.textContent.trim() === label && visible(tab));
  const find = (spec) => {
    if (spec.css) return deepAll(document, spec.css).find(visible) ?? null;
    const tab = tabFor(spec.group);
    if (!tab) return null;
    const strip = tab.closest("[role=tablist]").parentElement;
    return spec.part === "tab" ? tab : spec.part === "strip" ? strip : strip.parentElement;
  };
  // A face's size-adjust scales what it draws without changing the computed font-size (the Tauri build gives Timeless Sans 104%).
  const sizeAdjust = (stack) => {
    const faces = [...document.fonts].filter((face) => face.status === "loaded");
    for (const family of stack.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""))) {
      const face = faces.find((f) => f.family.replace(/^["']|["']$/g, "") === family);
      if (face) return face.sizeAdjust && face.sizeAdjust !== "100%" ? parseFloat(face.sizeAdjust) / 100 : 1;
    }
    return 1;
  };
  const out = {};
  for (const spec of regions) {
    const el = find(spec);
    if (!el) { out[spec.name] = null; continue; }
    el.setAttribute("data-parity-region", spec.name);
    const entry = { bounds: box(el), text: null };
    if (spec.text) {
      const node = textNodes(el)[0];
      if (node) {
        const parent = node.parentElement;
        parent.setAttribute("data-parity-text", spec.name);
        const cs = getComputedStyle(parent);
        const range = document.createRange();
        range.selectNodeContents(node);
        const line = range.getClientRects()[0];
        entry.text = {
          content: node.data.trim().slice(0, 60),
          stack: cs.fontFamily,
          cssSize: parseFloat(cs.fontSize),
          size: parseFloat(cs.fontSize) * sizeAdjust(cs.fontFamily),
          weight: parseFloat(cs.fontWeight),
          // "normal" leaves the line box to the font: take the box the run occupies.
          lineHeight: cs.lineHeight === "normal" ? (line?.height ?? null) : parseFloat(cs.lineHeight),
        };
      }
    }
    out[spec.name] = entry;
  }
  const textRects = [];
  for (const node of textNodes(document.body)) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) textRects.push({ x: r.x, y: r.y, w: r.width, h: r.height });
  }
  const contentRects = content.flatMap((selector) => deepAll(document, selector).filter(visible).map(box));
  return { regions: out, textRects, contentRects };
}
