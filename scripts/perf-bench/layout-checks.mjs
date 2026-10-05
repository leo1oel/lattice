/**
 * Geometry the app must keep, checked in a real browser (`pnpm perf:bench
 * --layout`): jsdom lays nothing out, so an overlap between two controls can
 * only be seen here. Each check loads the bench page with its own query at its
 * own viewport, drives it with the scenarios' BenchDriver and throws to fail.
 */

const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height;

const PDF_ACTION = '.paper-local-actions [aria-label="View original PDF"]';
const PDF_SEARCH = '.trellis-pdf-snapshot input[aria-label="Search PDF"]';

/** Where an element sits now, measured without scrolling it into view as `driver.rect` does. */
const placeOf = (driver, selector) => driver.waitFor(`(() => {
  const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
  return rect && rect.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, top: rect.top, bottom: rect.bottom } : null;
})()`, { what: selector });

const WRITING_TOOLBAR = ".trellis-pdf .pdf-toolbar";

/**
 * The PDF toolbar's visible controls that overlap, or sit outside the
 * toolbar, and how wide the search field's text box is beside the room a
 * short query needs (pdf-toolbar-min-width.ts's sample, in the field's font).
 */
const findToolbarGeometry = (driver) => driver.evaluate(`(() => {
  const toolbar = document.querySelector(${JSON.stringify(WRITING_TOOLBAR)});
  const input = toolbar.querySelector('input[aria-label="Search PDF"]');
  const style = getComputedStyle(input);
  const context = document.createElement("canvas").getContext("2d");
  context.font = style.fontStyle + " " + style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
  const bounds = toolbar.getBoundingClientRect();
  const controls = [...toolbar.querySelectorAll("button, input, .pdf-search-position")]
    .filter((element) => element.getClientRects().length && element.getAttribute("aria-hidden") !== "true")
    .map((element) => ({ name: element.getAttribute("aria-label") || element.className, rect: element.getBoundingClientRect() }));
  const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const problems = [];
  controls.forEach((a, index) => {
    if (a.rect.left < bounds.left - 0.5 || a.rect.right > bounds.right + 0.5) problems.push(a.name + " is outside the toolbar");
    for (const b of controls.slice(index + 1)) if (overlaps(a.rect, b.rect)) problems.push(a.name + " overlaps " + b.name);
  });
  return {
    problems,
    input: Math.round(input.getBoundingClientRect().width),
    usable: Math.ceil(context.measureText("00000000").width),
    names: controls.map((control) => control.name),
  };
})()`);

const COMPILED_PDF = ".pdf-column > .pdf-preview";
const PDF_SCROLLER = `${COMPILED_PDF} .pdf-scroll-area-viewport:not(.pdf-viewer-staging)`;

/** Where the "Page N: …" heading of the compiled fixture PDF's page N is, if drawn and on screen. */
const pdfHeading = (page) => `(() => {
  const span = [...document.querySelectorAll(${JSON.stringify(`${COMPILED_PDF} .page[data-page-number="${page}"] .textLayer span`)})]
    .find((node) => node.textContent.startsWith(${JSON.stringify(`Page ${page}:`)}));
  const rect = span?.getBoundingClientRect();
  return rect && rect.top >= 0 && rect.bottom <= innerHeight ? { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 } : null;
})()`;

/** Once every page on screen in the compiled preview is drawn. */
const pdfViewDrawn = (driver, what) => driver.waitFor(`(() => {
  const scroller = document.querySelector(${JSON.stringify(PDF_SCROLLER)});
  const view = scroller.getBoundingClientRect();
  const shown = [...scroller.querySelectorAll(".page")].filter((page) => {
    const rect = page.getBoundingClientRect();
    return rect.bottom > view.top && rect.top < view.bottom;
  });
  return shown.length > 0 && shown.every((page) => page.querySelector(".canvasWrapper canvas"));
})()`, { what });

/** The compiled 400-page preview at 40%, pages 1 to 3 drawn: where their headings are. */
async function pdfPagesOneToThreeAt40(driver) {
  await driver.waitFor(`document.querySelector(${JSON.stringify(`${COMPILED_PDF} .page[data-page-number="1"] .textLayer span`)})`, {
    timeout: 60_000, what: "page 1's text",
  });
  await driver.click(`${COMPILED_PDF} .pdf-overflow-trigger`);
  await driver.click('[role="menuitem"][aria-label="Enter a zoom percentage"]');
  const zoom = `${COMPILED_PDF} input[aria-label="PDF zoom percentage"]`;
  await driver.waitFor(`!document.querySelector('[role="menu"]') && document.activeElement?.matches(${JSON.stringify(zoom)})`, {
    timeout: 5_000, what: "the menu to close and the zoom field to take focus",
  });
  for (let frame = 0; frame < 3; frame += 1) await driver.nextFrame();
  await driver.evaluate("document.activeElement.select()");
  await driver.type("40");
  await driver.type("\n");
  const headings = await driver.waitFor(`(() => {
    const first = ${pdfHeading(1)};
    const third = ${pdfHeading(3)};
    return first && third ? [first, third] : null;
  })()`, { timeout: 10_000, what: "pages 1 to 3 on screen at 40%" });
  await pdfViewDrawn(driver, "pages 1 to 3 drawn");
  return headings;
}

/** Record what the app writes to the clipboard in `window.__benchClipboard`. */
const recordClipboard = (driver) => driver.evaluate(`(() => {
  const internals = window.__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  window.__benchClipboard = [];
  internals.invoke = (command, args, options) => {
    if (command === "plugin:clipboard-manager|write_text") window.__benchClipboard.push(String(args?.text ?? ""));
    return invoke(command, args, options);
  };
})()`);

export const LAYOUT_CHECKS = [
  {
    name: "paper-header-long-doi",
    description: "A Paper with a very long DOI and a long corporate author, read in a ~500px header: the PDF action never covers the source link.",
    query: { papers: "library" },
    // The window size at which the reader's header comes out about 500px wide.
    width: 1180,
    height: 900,
    async run(driver) {
      await driver.click('.paper-open[title="Reading the original of a paper with a very long DOI"]');
      await driver.rect(PDF_ACTION);
      const header = await driver.stableRect(".paper-reader-header");
      if (header.width < 460 || header.width > 540) throw new Error(`the reader's header is ${header.width}px wide, not about 500px: adjust the check's window width`);
      // Squeezed, the action group's buttons used to overflow it leftwards
      // over the source's link arrow, and a click on the arrow opened the PDF.
      const clipped = await driver.evaluate(`(() => { const label = document.querySelector(".paper-identity-source > span"); return label.scrollWidth > label.clientWidth; })()`);
      if (!clipped) throw new Error("the DOI fits the header, so nothing squeezes it: lengthen the fixture's DOI");
      const source = await driver.rect(".paper-identity-source");
      const action = await driver.rect(PDF_ACTION);
      if (overlaps(source, action)) throw new Error(`the source link (${source.left}–${source.left + source.width}px) and the PDF action (${action.left}–${action.left + action.width}px) overlap`);
      const arrow = await driver.rect(".paper-identity-source svg");
      if (!(await driver.evaluate(`window.__benchHits(".paper-identity-source", ${arrow.x}, ${arrow.y})`))) {
        throw new Error("a click on the source's link arrow lands on something else");
      }
    },
  },
  {
    name: "reading-field-focus-after-shrink",
    description: "Reading, notes active beside a PDF, window shrunk from 1440×900 to 1024×768: clicking and typing in the PDF's search field leaves the workspace in place, its tabs and toolbar on screen.",
    query: { pdfPages: 3 },
    width: 1440,
    height: 900,
    async run(driver) {
      await driver.openFile("notes/note-000.md");
      await driver.openFile("reference.pdf");
      await driver.click(".trellis-preset-tabs [role=tab]:nth-child(2)");
      await driver.waitFor(`document.querySelector('[data-panel="panel-reading"]')`, { what: "the Reading layout" });
      await driver.click(".trellis-snapshot");
      // The notes take focus once they are the live document; a field clicked before then loses it.
      await driver.waitFor(`document.activeElement?.matches(".cm-content")`, { what: "the notes to take focus" });
      await placeOf(driver, PDF_SEARCH);
      await driver.page.resize(1024, 768);
      const roots = `[...document.querySelectorAll(".lattice-trellis .trellis")]`;
      // Shrunk, the workspace's content is taller than its root: a panel
      // surface off screen keeps the height it had at 900px.
      await driver.waitFor(`${roots}.some((root) => root.scrollHeight > root.clientHeight)`, {
        timeout: 5_000, what: "content taller than the shrunk workspace: reproduce the overflow another way",
      });
      // A root that can scroll is scrolled by whatever brings a focused
      // element or a search match into view, taking the tabs and toolbar of
      // every panel up past the titlebar.
      const anchored = async (when) => {
        await driver.nextFrame();
        const scrolled = await driver.evaluate(`${roots}.map((root) => root.scrollTop).filter(Boolean)`);
        if (scrolled.length) throw new Error(`the workspace root scrolled by ${scrolled.join(", ")}px ${when}`);
      };
      await anchored("when the window shrank");
      const tab = '[data-panel="panel-reading"] [data-trellis-part="tab"][data-selected]';
      const tabTop = (await placeOf(driver, tab)).top;
      const field = await placeOf(driver, PDF_SEARCH);
      // Where a person clicks it: no scrollIntoView first, as driver.click does.
      await driver.clickAt(field.x, field.y);
      await driver.waitFor(`document.activeElement?.matches(${JSON.stringify(PDF_SEARCH)})`, { timeout: 5_000, what: "the search field to take focus" });
      await anchored("when the search field took focus");
      await driver.type("Page");
      await driver.waitFor(`document.querySelector(".trellis-pdf-snapshot .pdfViewer .highlight")`, { what: "a search match" });
      await anchored("when a search was typed");
      const tabAfter = (await placeOf(driver, tab)).top;
      const fieldAfter = (await placeOf(driver, PDF_SEARCH)).top;
      if (tabAfter !== tabTop || fieldAfter !== field.top) {
        throw new Error(`the PDF's tab moved from ${tabTop}px to ${tabAfter}px and its search field from ${field.top}px to ${fieldAfter}px`);
      }
    },
  },
  {
    name: "writing-pdf-find-narrow",
    description: "Writing, a query in the PDF's Find, the window at its 640px minimum and narrower: the query keeps a readable box and no control is drawn over another.",
    query: {},
    width: 1280,
    height: 800,
    async run(driver) {
      await driver.click(".trellis-preset-tabs [role=tab]:nth-child(1)");
      await driver.waitFor(`document.querySelector('[data-panel="panel-writing"]')`, { what: "the Writing layout" });
      const search = `${WRITING_TOOLBAR} input[aria-label="Search PDF"]`;
      await placeOf(driver, search);
      await driver.click(search);
      await driver.type("Page");
      await driver.waitFor(`document.querySelector(".trellis-pdf .pdfViewer .highlight")`, { what: "a search match" });
      // 640px is the native window's minimum; narrower stands in for a PDF
      // panel the layout cannot give its own minimum (a wide source beside it).
      for (const width of [640, 560, 480]) {
        await driver.page.resize(width, 800);
        await driver.nextFrame();
        await driver.nextFrame();
        const geometry = await findToolbarGeometry(driver);
        if (geometry.problems.length) throw new Error(`at ${width}px: ${geometry.problems.join("; ")}`);
        if (geometry.input < geometry.usable) {
          throw new Error(`at ${width}px the query's box is ${geometry.input}px wide, under the ${geometry.usable}px a short query needs`);
        }
      }
      // Cleared, the toolbar comes back whole.
      await driver.click(`${WRITING_TOOLBAR} [aria-label="Clear PDF search"]`);
      await driver.waitFor(`document.querySelector(${JSON.stringify(`${WRITING_TOOLBAR} [aria-label="Previous page"]`)})?.getClientRects().length > 0`, {
        timeout: 5_000, what: "the page controls back once the search is cleared",
      });
      const idle = await findToolbarGeometry(driver);
      if (idle.problems.length) throw new Error(`with the search cleared: ${idle.problems.join("; ")}`);
    },
  },
  {
    name: "pdf-live-drag-copy",
    description: "A 400-page compiled PDF at 40%, a drag from page 1's heading to page 3's, the button still held through two wheel steps far down: releasing, scrolling on, and pressing Cmd-C copy pages 1 and 2.",
    query: { pdfPages: 400, build: "clean" },
    width: 1440,
    height: 900,
    async run(driver) {
      const [first, third] = await pdfPagesOneToThreeAt40(driver);

      // The text a person sees selected, before the drag ends.
      await driver.mouse("mouseMoved", first.left + 1, first.y, { button: "none" });
      await driver.mouse("mousePressed", first.left + 1, first.y);
      for (let step = 1; step <= 10; step += 1) {
        await driver.mouse("mouseMoved", first.left + 1 + (third.right - 2 - first.left) * step / 10, first.y + (third.y - first.y) * step / 10, { buttons: 1 });
      }
      const selected = await driver.evaluate("getSelection().toString()");
      if (!selected.includes("Page 1:") || !selected.includes("Page 2:")) throw new Error("the drag did not select from page 1 into page 3");

      // Each step draws pages far below, past PDF.js's ten-page cache: the
      // oldest drawn ones, the selected pages, are evicted on the way.
      for (let step = 0; step < 2; step += 1) {
        await driver.mouse("mouseWheel", third.right - 2, third.y, { button: "none", buttons: 1, deltaX: 0, deltaY: 14_000 });
        await driver.nextFrame();
        await pdfViewDrawn(driver, `the pages under wheel step ${step + 1} drawn`);
      }
      if (await driver.evaluate(`!!document.querySelector(${JSON.stringify(`${COMPILED_PDF} .page[data-page-number="1"] canvas`)})`)) {
        throw new Error("page 1 is still drawn, so nothing evicted it: scroll further");
      }
      await driver.mouse("mouseReleased", third.right - 2, third.y);

      await recordClipboard(driver);
      const parked = await driver.waitFor(`document.querySelector(".pdf-copy-field")?.value`, { timeout: 5_000, what: "the released drag's text" });
      for (const heading of ["Page 1:", "Page 2:"]) {
        if (!parked.includes(heading)) throw new Error(`the released drag's ${parked.length} characters lost "${heading}"`);
      }

      // One more step draws a page, so the buffer lets go of the pages it kept
      // for the drag and their text layers are disposed.
      await driver.mouse("mouseWheel", third.right - 2, third.y, { button: "none", deltaX: 0, deltaY: 14_000 });
      await driver.nextFrame();
      await pdfViewDrawn(driver, "the pages under the wheel step after release drawn");
      const kept = await driver.evaluate(`document.querySelector(".pdf-copy-field")?.value ?? ""`);
      for (const heading of ["Page 1:", "Page 2:"]) {
        if (!kept.includes(heading)) throw new Error(`a scroll after release left ${kept.length} characters without "${heading}"`);
      }
      await driver.shortcut("c");
      const copied = await driver.waitFor("window.__benchClipboard.at(-1)", { timeout: 5_000, what: "Cmd-C to write the clipboard" });
      if (copied !== kept) throw new Error(`Cmd-C copied ${copied.length} characters, not the released drag's ${kept.length}`);
    },
  },
  {
    name: "pdf-parked-drag-zoom-scroll",
    description: "A completed drag from page 1's heading to page 3's in a 400-page compiled PDF at 40%, then a pinch zoom, a scroll far enough to evict page 1, and back: page 1 is still highlighted and Cmd-C copies pages 1 and 2.",
    query: { pdfPages: 400, build: "clean" },
    width: 1440,
    height: 900,
    async run(driver) {
      const [first, third] = await pdfPagesOneToThreeAt40(driver);
      await driver.mouse("mouseMoved", first.left + 1, first.y, { button: "none" });
      await driver.mouse("mousePressed", first.left + 1, first.y);
      for (let step = 1; step <= 10; step += 1) {
        await driver.mouse("mouseMoved", first.left + 1 + (third.right - 2 - first.left) * step / 10, first.y + (third.y - first.y) * step / 10, { buttons: 1 });
      }
      await driver.mouse("mouseReleased", third.right - 2, third.y);
      await recordClipboard(driver);
      const parked = await driver.waitFor(`document.querySelector(".pdf-copy-field")?.value`, { timeout: 5_000, what: "the released drag's text" });
      for (const heading of ["Page 1:", "Page 2:"]) {
        if (!parked.includes(heading)) throw new Error(`the released drag's ${parked.length} characters lack "${heading}"`);
      }

      // A trackpad pinch, as Chromium reports it: a Ctrl-wheel over the page.
      await driver.evaluate(`document.elementFromPoint(${first.left + 1}, ${first.y}).dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -40, clientX: ${first.left + 1}, clientY: ${first.y},
      }))`);
      // The preview is a transform; once input stops PDF.js draws the pages
      // again at the new scale and the highlight is repainted on them.
      const headingHeight = `(() => {
        const span = [...document.querySelectorAll(${JSON.stringify(`${COMPILED_PDF} .page[data-page-number="1"] .textLayer span`)})]
          .find((node) => node.textContent.startsWith("Page 1:"));
        return span ? span.offsetHeight : 0;
      })()`;
      const before = await driver.evaluate(headingHeight);
      await driver.waitFor(`!document.querySelector(${JSON.stringify(`${COMPILED_PDF} .pdfViewer`)}).style.transform
        && ${headingHeight} > ${before * 1.3}
        && document.querySelector(${JSON.stringify(`${COMPILED_PDF} .page[data-page-number="1"] .pdf-sel-rect`)})`, {
        timeout: 10_000, what: "page 1 drawn again zoomed, with its highlight",
      });
      await pdfViewDrawn(driver, "the zoomed pages drawn");

      const scroller = await driver.waitFor(`window.__benchVisibleRect(${JSON.stringify(PDF_SCROLLER)})`, { what: "the PDF's scroller" });
      for (const deltaY of [14_000, 14_000, 14_000, 14_000]) {
        await driver.mouse("mouseWheel", scroller.x, scroller.y, { button: "none", deltaX: 0, deltaY });
        await driver.nextFrame();
        await pdfViewDrawn(driver, "the pages scrolled to drawn");
      }
      if (await driver.evaluate(`!!document.querySelector(${JSON.stringify(`${COMPILED_PDF} .page[data-page-number="1"] canvas`)})`)) {
        throw new Error("page 1 is still drawn, so nothing evicted it: scroll further");
      }
      await driver.evaluate(`document.querySelector(${JSON.stringify(PDF_SCROLLER)}).scrollTop = 0`);
      await driver.waitFor(`${pdfHeading(1)} && document.querySelector(${JSON.stringify(`${COMPILED_PDF} .page[data-page-number="1"] .pdf-sel-rect`)})`, {
        timeout: 10_000, what: "page 1 back on screen with its highlight",
      });
      await driver.shortcut("c");
      const copied = await driver.waitFor("window.__benchClipboard.at(-1)", { timeout: 5_000, what: "Cmd-C to write the clipboard" });
      if (copied !== parked) throw new Error(`Cmd-C copied ${copied.length} characters, not the released drag's ${parked.length}`);
    },
  },
];
