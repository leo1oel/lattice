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
      await driver.click(".trellis-presets [role=tab]:nth-child(3)");
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
      await driver.click(".trellis-presets [role=tab]:nth-child(2)");
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
];
