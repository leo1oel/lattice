/**
 * The browser check for the visual Markdown editor's block controls
 * (`pnpm perf:bench --layout --only markdown-block-controls-lanes`), beside
 * the layout checks it runs with: jsdom lays nothing out, so only a browser
 * shows whether the controls clear the heading rail and the source pane.
 */

export const MARKDOWN_BLOCK_CONTROLS_LANES = {
  name: "markdown-block-controls-lanes",
  description: "large.md in a ~830px Preview with its heading rail, then in Split: every hovered block's Add block below and grip are clear of the rail and of the source pane, and a press on either lands on it.",
  query: { largeMarkdownBytes: 30_000 },
  width: 1180,
  height: 900,
  async run(driver) {
    await driver.openFile("large.md");
    for (const view of ["Preview", "Split"]) {
      await driver.selectView(view);
      await driver.rect(".lx-md-surface");
      if (view === "Preview") await driver.rect(".lx-md-editor .visual-heading-rail-nav");
      // The rail used to share the controls' margin, so a hover there drew
      // the controls under its ticks; in Split the margin was narrower than
      // the controls and the source pane covered Add block below.
      const blocks = await driver.evaluate(`[...document.querySelectorAll(".lx-md-surface > :is(h1, h2, p, table, .tableWrapper)")]
        .map((block) => block.getBoundingClientRect())
        .filter((rect) => rect.top > 100 && rect.top < innerHeight - 60)
        .slice(0, 6)
        .map((rect) => ({ x: rect.left + 12, y: rect.top + 6 }))`);
      if (blocks.length < 3) throw new Error(`only ${blocks.length} blocks of large.md are on screen in ${view}`);
      for (const block of blocks) {
        await driver.mouse("mouseMoved", block.x, block.y, { button: "none" });
        const found = await driver.waitFor(`(() => {
          const pane = document.querySelector(".lx-md-editor").closest(".markdown-preview-content")?.getBoundingClientRect() ?? document.querySelector(".lx-md-editor").getBoundingClientRect();
          const rail = document.querySelector(".lx-md-editor .visual-heading-rail-nav")?.getBoundingClientRect();
          const buttons = [...document.querySelectorAll(".lx-md-block-controls button")];
          if (!buttons.length) return null;
          return buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            return {
              name: button.getAttribute("aria-label"),
              inPane: rect.left >= pane.left && rect.right <= pane.right,
              onRail: Boolean(rail && rect.left < rail.right && rail.left < rect.right && rect.top < rail.bottom && rail.top < rect.bottom),
              hits: button.contains(document.elementFromPoint(x, y)),
            };
          });
        })()`, { timeout: 5_000, what: `block controls for the block at ${block.y}px in ${view}` });
        for (const control of found) {
          if (!control.inPane) throw new Error(`${view}: ${control.name} lies outside the editor's pane`);
          if (control.onRail) throw new Error(`${view}: ${control.name} is drawn over the heading rail`);
          if (!control.hits) throw new Error(`${view}: a press on ${control.name} lands on something else`);
        }
        if (view === "Split" && !found.some((control) => control.name === "Add block below")) throw new Error("Split: a block's controls have no Add block below");
      }
    }
  },
};
