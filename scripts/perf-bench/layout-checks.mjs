/**
 * Geometry the app must keep, checked in a real browser (`pnpm perf:bench
 * --layout`): jsdom lays nothing out, so an overlap between two controls can
 * only be seen here. Each check loads the bench page with its own query at its
 * own viewport, drives it with the scenarios' BenchDriver and throws to fail.
 */

const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height;

const PDF_ACTION = '.paper-local-actions [aria-label="View original PDF"]';

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
];
