/**
 * The browser check for LaTeX Visual mode (`pnpm perf:bench --layout --only
 * latex-visual-reveal`), beside the layout checks it runs with: jsdom has no
 * real selection, focus or click targeting, so only a browser shows that a
 * click on an equation opens its source and typing edits only there.
 */

const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height;

export const LATEX_VISUAL_REVEAL = {
  name: "latex-visual-reveal",
  description: "A LaTeX chapter switched to Visual: its math is set, a click on an equation opens its source with the caret inside, typing edits only there, leaving draws it again, and switching back to Source leaves the text as it was.",
  query: {},
  width: 1440,
  height: 900,
  async run(driver) {
    const content = '[data-editor-pane="primary"] .cm-content';
    const view = `document.querySelector(${JSON.stringify(content)}).cmTile.root.view`;
    await driver.openFile("chapters/ch01.tex");
    const before = await driver.evaluate(`${view}.state.doc.toString()`);
    await driver.selectLatexView("Visual");
    // The switch sits beside Build without covering it.
    const [views, build] = await driver.evaluate(`[...document.querySelectorAll('[aria-label="LaTeX editor view"], .trellis-build-button')]
      .filter((element) => !element.closest("[inert]")).map((element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; })`);
    if (!views || !build || overlaps(views, build)) throw new Error(`the Source / Visual switch ${JSON.stringify(views)} overlaps Build ${JSON.stringify(build)}`);
    const equation = `${content} .lx-tex-math-display`;
    await driver.waitFor(`document.querySelector(${JSON.stringify(`${equation} .katex`)})`, { what: "a display equation set by KaTeX" });
    const drawn = await driver.evaluate(`document.querySelector(${JSON.stringify(content)}).textContent`);
    if (drawn.includes("\\section{") || drawn.includes("\\begin{equation}")) throw new Error("Visual mode left sectioning or equation commands showing");
    await driver.click(equation);
    const opened = await driver.waitFor(`(() => {
      const editor = ${view};
      const head = editor.state.selection.main.head;
      return document.querySelector(${JSON.stringify(content)}).textContent.includes(${JSON.stringify("\\begin{equation}")}) && { head };
    })()`, { timeout: 5_000, what: "the clicked equation's source" });
    await driver.type("q");
    const typed = await driver.evaluate(`${view}.state.doc.toString()`);
    if (typed !== before.slice(0, opened.head) + "q" + before.slice(opened.head)) throw new Error(`typing in the opened equation changed more than one character at ${opened.head}`);
    // Leave it: the caret on the chapter's first line draws the equation again.
    await driver.evaluate(`(() => { const editor = ${view}; editor.dispatch({ selection: { anchor: 0 } }); })()`);
    await driver.waitFor(`!document.querySelector(${JSON.stringify(content)}).textContent.includes(${JSON.stringify("\\begin{equation}")})`, { timeout: 5_000, what: "the equation drawn again" });
    await driver.selectLatexView("Source");
    const after = await driver.evaluate(`${view}.state.doc.toString()`);
    if (after !== typed) throw new Error("switching back to Source changed the text");
  },
};
