// The named regions the parity diff compares, per screen: what each one is in
// the Tauri app's DOM, and which checks apply to it. The GPUI app records the
// same names with `lattice_ui::parity` probes (the titlebar, the panels'
// cards, strips and tabs, tree rows, the status bar, the build chip), and
// each run of text in a region with a `lattice_ui::parity::text_probe`.
//
// A region is found by a CSS selector (`css`, searched through shadow roots,
// so the file tree's rows are found too), or as part of a panel's tab group
// (`group`: the card, the 40px strip or the tab of the panel whose tab reads
// that label). Checks:
//   bounds  its box within ±1 px (default on)
//   text    every run of text in it: family, size, weight and line height
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
      { name: "pdf/page", css: ".pdf-page-value", text: true },
      // No zoom label: the PDF panel is narrower than the toolbar's 640 px
      // container query at this size, so the Tauri app folds zoom into the
      // overflow menu (pdf-viewer.css); the GPUI app's toolbar has none either.
      { name: "pdf/find", css: ".pdf-search", text: true },
      { name: "build-chip", css: ".trellis-build-button", text: true, chrome: true },
      { name: "status-bar", css: ".editor-status-bar", chrome: true },
      { name: "status/position", css: ".status-goto", text: true },
      { name: "status/save", css: ".status-save", text: true },
      { name: "status/words", css: ".status-body-words", text: true },
      // Zed's editor in the GPUI app: its box is not the same element, and its
      // one text style (from the settings, with no content) stands for every run on the line.
      { name: "editor/text", css: ".cm-content .cm-line", text: true, bounds: false },
      // The source gutter (src/editor/source-gutter.ts): the first line's
      // number cell (four digits wide, whatever the line count) and its fold
      // cell, then the first line's box, which starts 6px before its text and
      // ends where the outline rail's clearance begins.
      { name: "editor/line-number", css: ".source-editor .cm-lineNumbers .cm-gutterElement", text: true },
      { name: "editor/fold", css: ".source-editor .cm-foldGutter .cm-gutterElement" },
      { name: "editor/line", css: ".source-editor .cm-content .cm-line" },
      // The .tex file's Source / Visual switch before the Build chip, and
      // the outline rail's marks on the editor's right edge.
      { name: "editor/view-switch", css: ".trellis-view-switcher", text: true },
      { name: "editor/outline-rail", css: ".latex-outline-rail-marks" },
    ],
    // Drawn by different engines in the two apps (pdf.js and PDFium), so left out of the pixel budget.
    content: [".pdf-viewer-host"],
  },
  // The tutorial with its HTML demo opened (`scenes.html`): the document's
  // card, strip and tab, its Edit / Split / Preview switch, the preview and
  // the zoom controls over it. The GPUI app draws the page in a webview
  // island, which an offscreen capture does not include, so the page itself
  // is left out of the pixel budget; the chrome over it is compared.
  html: {
    label: "HTML",
    regions: [
      { name: "titlebar", css: "header.titlebar", chrome: true },
      { name: "workspace", css: "main.workspace", chrome: true },
      ...group("attention-demo.html"),
      { name: "html/views", css: "[data-trellis-part=\"accessory\"]:not([data-inactive]) .trellis-view-switcher" },
      { name: "html/preview", css: ".html-preview" },
      // Its percentage is an <input>'s value in the Tauri app, which has no
      // text run to compare; the box is compared.
      { name: "html/zoom", css: ".html-preview-zoom-controls" },
    ],
    content: [".html-preview-frame", ".pdf-viewer-host"],
  },
  // The tutorial's notes opened in Preview (`scenes.markdown`): the
  // document's card, strip and tab, its Edit / Split / Preview switch, and
  // the visual editor's surface. The GPUI app draws the visual editor in a
  // webview island, which an offscreen capture does not include, so it is
  // left out of the pixel budget; the composited capture beside the report
  // shows it.
  markdown: {
    label: "Markdown",
    regions: [
      { name: "titlebar", css: "header.titlebar", chrome: true },
      { name: "workspace", css: "main.workspace", chrome: true },
      ...group("notes.md"),
      { name: "markdown/views", css: "[data-trellis-part=\"accessory\"]:not([data-inactive]) .trellis-view-switcher" },
      { name: "markdown/surface", css: ".markdown-preview" },
    ],
    content: [".markdown-preview", ".pdf-viewer-host"],
  },
  // The tutorial's spreadsheet and board opened (`scenes.sheet`,
  // `scenes.board`): the document's card, strip and tab, and the surface,
  // alone in the panel with no status bar or strip tools, as the Tauri
  // canvas shows a structured document. The editor itself is a webview
  // island in the GPUI app, which an offscreen capture does not include, so
  // it is left out of the pixel budget; the composited capture beside the
  // report shows it.
  sheet: {
    label: "Spreadsheet",
    regions: [
      { name: "titlebar", css: "header.titlebar", chrome: true },
      { name: "workspace", css: "main.workspace", chrome: true },
      ...group("attention-results.lattice-sheet"),
      { name: "sheet/surface", css: ".spreadsheet-editor-root" },
    ],
    content: [".spreadsheet-editor-root", ".pdf-viewer-host"],
  },
  board: {
    label: "Board",
    regions: [
      { name: "titlebar", css: "header.titlebar", chrome: true },
      { name: "workspace", css: "main.workspace", chrome: true },
      ...group("attention-map.tldr"),
      { name: "board/surface", css: ".board-editor-root" },
    ],
    content: [".board-editor-root", ".pdf-viewer-host"],
  },
  // A window without a project (`?welcome=1&recents=1`): the newest recent
  // project's folder is gone, so the welcome screen says so; the desk lays
  // out the next three. The GPUI side stages the same list
  // (crates/lattice-gpui/src/scenario/parity_welcome.rs).
  welcome: {
    label: "Welcome",
    regions: [
      { name: "welcome/settings", css: ".welcome-titlebar .icon-button" },
      { name: "welcome/mark", css: ".welcome-content > .brand-mark" },
      { name: "welcome/title", css: ".welcome-content > h1", text: true },
      { name: "welcome/actions", css: ".welcome-actions" },
      { name: "welcome/unopened", css: ".welcome-unopened", text: true },
      { name: "welcome/recents-title", css: ".welcome-recents-title", text: true },
      { name: "welcome/desk", css: ".welcome-desk" },
      { name: "welcome/card/0", css: ".welcome-desk > li:nth-child(1) .welcome-desk-card", text: true },
      { name: "welcome/card/1", css: ".welcome-desk > li:nth-child(2) .welcome-desk-card", text: true },
      { name: "welcome/card/2", css: ".welcome-desk > li:nth-child(3) .welcome-desk-card", text: true },
      { name: "welcome/more", css: ".welcome-more", text: true },
    ],
    // The desk's first page is drawn by pdf.js in the Tauri app and by
    // PDFium here, so left out of the pixel budget.
    content: [".welcome-desk-sheet[data-kind=\"page\"] > img"],
  },
  // The History panel (`scenes.history`): the paper's versions on the
  // mock backend (`?versions=compare`), History opened from the titlebar
  // into the documents' panel. The GPUI side makes the same versions real
  // in a Git repository (crates/lattice-gpui/src/scenario/parity_history.rs).
  history: {
    label: "History",
    regions: [
      { name: "titlebar", css: "header.titlebar", chrome: true },
      { name: "workspace", css: "main.workspace", chrome: true },
      ...group("History"),
      { name: "history/toolbar", css: ".versions-toolbar" },
      { name: "history/view/active", css: '.history-view[aria-pressed="true"]', text: true, chrome: true },
      { name: "history/compare", css: ".history-compare", text: true },
      { name: "history/save", css: ".versions-toolbar .versions-save", text: true },
      { name: "history/refresh", css: ".versions-toolbar .versions-icon-button" },
      { name: "history/day", css: ".history-day-label", text: true, chrome: true },
      { name: "history/row", css: ".history-row" },
      { name: "history/row/glyph", css: ".history-row-glyph", chrome: true },
      { name: "history/row/head", css: ".history-row-head" },
      { name: "history/row/title", css: ".history-row-title", text: true },
      { name: "history/row/time", css: ".history-row-time", text: true },
      { name: "history/fold", css: ".history-fold" },
      { name: "history/fold/title", css: ".history-fold .history-row-title", text: true },
    ],
    content: [".pdf-viewer-host"],
  },
  // Compare… pressed on that panel (`scenes.historyCompare`): the version
  // picker, the range, the counts and the first changed passage.
  historyCompare: {
    label: "History · compare",
    regions: [
      ...group("History"),
      { name: "compare/back", css: ".compare-back", text: true },
      { name: "compare/heading", css: ".compare-heading h2", text: true },
      { name: "compare/picker", css: ".compare-picker", chrome: true },
      { name: "compare/picker/head", css: ".compare-picker-head" },
      { name: "compare/picker/row", css: ".compare-picker-row" },
      { name: "compare/bar", css: ".compare-bar" },
      { name: "compare/counts", css: ".compare-counts" },
      { name: "compare/passage", css: ".compare-passage" },
    ],
    content: [".pdf-viewer-host"],
  },
  settings: {
    label: "Settings",
    // Settings over the Main window, on Appearance (scenes.mjs `settings`).
    // The GPUI app lists only the sections it has (Appearance, Editor &
    // builds, TeX doctor), so the left column's lower groups differ; the
    // regions are the dialog's frame, its columns, the page's title and
    // first group, and the first rows.
    regions: [
      { name: "settings/modal", css: ".settings-modal", chrome: true },
      { name: "settings/nav", css: ".settings-nav", chrome: true },
      { name: "settings/content", css: ".settings-content", chrome: true },
      { name: "settings/search", css: ".settings-search" },
      { name: "settings/nav/active", css: ".settings-nav-group > button.active", text: true, chrome: true },
      { name: "settings/nav/label", css: ".settings-nav-group-label", text: true },
      { name: "settings/title", css: ".settings-section .ui-settings-section-header-title", text: true },
      { name: "settings/group", css: ".settings-section .ui-settings-group-body", chrome: true },
      { name: "settings/row/interface-language", css: '[data-setting="interface-language"]' },
      { name: "settings/row/interface-language/label", css: '[data-setting="interface-language"] .ui-settings-row-label', text: true },
      { name: "settings/row/interface-size", css: '[data-setting="interface-size"]' },
      { name: "settings/row/interface-sounds", css: '[data-setting="interface-sounds"]' },
      { name: "settings/row/toast-position", css: '[data-setting="toast-position"]' },
    ],
    content: [],
  },
  // "Open from Overleaf" over the Main window (scenes.mjs `overleafPicker`):
  // the dialog, its header and account chip, the search row, the list frame,
  // the chosen row and the next, and the upload offer.
  overleafPicker: {
    label: "Open from Overleaf",
    regions: [
      { name: "overleaf/picker", css: ".overleaf-picker-modal", chrome: true },
      { name: "overleaf/picker/title", css: ".overleaf-picker-header .ui-panel-header-title", text: true },
      { name: "overleaf/picker/account", css: ".overleaf-picker-account", text: true },
      { name: "overleaf/picker/search", css: ".overleaf-search" },
      { name: "overleaf/picker/archived", css: ".overleaf-checkbox", text: true },
      { name: "overleaf/picker/stage", css: ".overleaf-stage" },
      { name: "overleaf/picker/row/chosen", css: ".overleaf-project-row.selected", chrome: true },
      { name: "overleaf/picker/row", css: ".overleaf-project-row:not(.selected)" },
      { name: "overleaf/picker/row/name", css: ".overleaf-project-row:not(.selected) .overleaf-project-name", text: true },
      { name: "overleaf/picker/row/meta", css: ".overleaf-project-row:not(.selected) .overleaf-project-meta", text: true },
      { name: "overleaf/picker/open", css: ".overleaf-project-row.selected .overleaf-open-button:last-child", text: true },
      { name: "overleaf/picker/publish", css: ".overleaf-publish-card", chrome: true },
      { name: "overleaf/picker/publish/title", css: ".overleaf-publish-copy strong", text: true },
    ],
    content: [],
  },
  // Settings › Overleaf with the project linked and live (scenes.mjs
  // `settingsOverleaf`): the account's card, the link's, and the sync rows.
  settingsOverleaf: {
    label: "Settings · Overleaf",
    regions: [
      { name: "settings/modal", css: ".settings-modal", chrome: true },
      { name: "settings/nav/active", css: ".settings-nav-group > button.active", text: true, chrome: true },
      { name: "settings/title", css: ".settings-section .ui-settings-section-header-title", text: true },
      { name: "overleaf/settings/account", css: ".overleaf-status-row", chrome: true },
      { name: "overleaf/settings/account/title", css: ".overleaf-status-row .overleaf-status-text strong", text: true },
      { name: "overleaf/settings/link", css: ".overleaf-status-row + .overleaf-status-row", chrome: true },
      { name: "settings/row/overleaf-sync-mode", css: '[data-setting="overleaf-sync-mode"]' },
      { name: "settings/row/overleaf-sync-mode/label", css: '[data-setting="overleaf-sync-mode"] .ui-settings-row-label', text: true },
      { name: "settings/row/overleaf-remote-delete", css: '[data-setting="overleaf-remote-delete"]' },
    ],
    content: [],
  },
};

/**
 * Runs in the page: tags each region's element with data-parity-region (and
 * the element that holds each of its runs of text with data-parity-text) and
 * measures it. Returns { regions: {name: {bounds, texts}}, textRects,
 * contentRects }; textRects are every visible run's boxes,
 * contentRects the content regions' boxes, which the pixel budget leaves out.
 *
 * A run of text is a text node, or the value (else the placeholder) a
 * visible input shows; `texts` lists a region's runs in document order.
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
  const inputText = (el) => (el.value || el.placeholder || "").trim();
  const textRuns = (root) => {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { if (child.data.trim()) out.push(child); continue; }
        if (child.nodeType !== 1) continue;
        const cs = getComputedStyle(child);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (child.matches(".sr-only")) continue;
        if (child.matches("input, textarea")) { if (visible(child) && inputText(child)) out.push(child); continue; }
        walk(child);
        if (child.shadowRoot) walk(child.shadowRoot);
      }
    };
    walk(root);
    return out;
  };
  const runRects = (run) => {
    if (run.nodeType === 1) {
      const r = box(run), cs = getComputedStyle(run);
      const left = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), right = parseFloat(cs.borderRightWidth) + parseFloat(cs.paddingRight);
      const top = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop), bottom = parseFloat(cs.borderBottomWidth) + parseFloat(cs.paddingBottom);
      const content = { x: r.x + left, y: r.y + top, w: r.w - left - right, h: r.h - top - bottom };
      return content.w > 0 && content.h > 0 ? [content] : [];
    }
    const range = document.createRange();
    range.selectNodeContents(run);
    return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
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
  let tags = 0;
  const measureRun = (run) => {
    const input = run.nodeType === 1;
    const holder = input ? run : run.parentElement;
    const rects = runRects(run);
    if (!holder || !rects.length) return null;
    // Runs that share an element share its tag, and the face CDP reports for it.
    if (!holder.hasAttribute("data-parity-text")) holder.setAttribute("data-parity-text", String(tags++));
    const cs = getComputedStyle(holder);
    return {
      content: (input ? inputText(run) : run.data.trim()).replace(/\s+/g, " ").slice(0, 60),
      tag: holder.getAttribute("data-parity-text"),
      stack: cs.fontFamily,
      cssSize: parseFloat(cs.fontSize),
      size: parseFloat(cs.fontSize) * sizeAdjust(cs.fontFamily),
      weight: parseFloat(cs.fontWeight),
      // "normal" leaves the line box to the font: take the box the run occupies (an input's content box).
      lineHeight: cs.lineHeight === "normal" ? rects[0].h : parseFloat(cs.lineHeight),
    };
  };
  const out = {};
  for (const spec of regions) {
    const el = find(spec);
    if (!el) { out[spec.name] = null; continue; }
    el.setAttribute("data-parity-region", spec.name);
    const texts = spec.text ? textRuns(el).map(measureRun).filter(Boolean) : [];
    out[spec.name] = { bounds: box(el), texts };
  }
  const textRects = textRuns(document.body).flatMap(runRects);
  const contentRects = content.flatMap((selector) => deepAll(document, selector).filter(visible).map(box));
  return { regions: out, textRects, contentRects };
}
