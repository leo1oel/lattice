/**
 * The benchmark's interactions. Each scenario prepares the app (unmeasured),
 * then performs `steps` identical user actions with real input events sent
 * through CDP, so the counts include everything the browser does in response:
 * event handlers, React commits, style recalculation, layout and paint.
 *
 * Timing is fixed rather than as-fast-as-possible: every step waits for the
 * next frame and then a fixed pause, as a person typing or scrolling would.
 * Debounced work therefore fires the same number of times on a fast laptop
 * and a slow CI runner, which is what makes the counts comparable.
 */
import { BUILD_BUTTON } from "./selectors.mjs";

/** Pause after each keystroke: a quick typist, and longer than any per-keystroke debounce. */
const KEY_PAUSE_MS = 120;
/**
 * A pause that clears the visual editor's 200 ms publication idle for a small
 * document (markdown-preview-sync-policy.ts), so every keystroke publishes
 * once. KEY_PAUSE_MS plus a keystroke's round trip lands on that boundary and
 * publishes a different number of times from run to run.
 */
const PUBLISH_PAUSE_MS = 400;
const WHEEL_PAUSE_MS = 60;
/** After a zoom gesture: past the PDF zoom's commit delay (use-pdf-zoom.ts) and its re-render. */
const ZOOM_PAUSE_MS = 600;
/** Between a zoom gesture's notches: one 60 Hz frame, well inside the PDF zoom's commit delay. */
const ZOOM_NOTCH_MS = 16;

const KEY_CODES = {
  " ": ["Space", 32],
  ".": ["Period", 190],
  ",": ["Comma", 188],
  "\n": ["Enter", 13],
};

/** Page-side helpers, installed once per page load. `a >>> b` pierces a's shadow root. */
const PAGE_HELPERS = String.raw`
window.__benchQuery = (selector) => {
  let scope = document;
  const parts = selector.split(" >>> ");
  for (let index = 0; index < parts.length; index += 1) {
    const found = scope.querySelector(parts[index]);
    if (!found) return null;
    if (index === parts.length - 1) return found;
    scope = found.shadowRoot;
    if (!scope) return null;
  }
  return null;
};
window.__benchRect = (selector) => {
  const element = window.__benchQuery(selector);
  if (!element) return null;
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  const rect = element.getBoundingClientRect();
  return rect.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
};
// True when a click at (x, y) would land on an element matching the selector
// and not on something covering it, such as the picture the navigator animates
// a folder open with. Any match counts: the navigator also draws a sticky copy
// of an open folder's row over the original.
window.__benchHits = (selector, x, y) => {
  const element = window.__benchQuery(selector);
  const hit = element && element.getRootNode().elementFromPoint(x, y);
  return Boolean(hit && hit.closest(selector.split(" >>> ").pop()));
};
// The on-screen part of an element, without scrolling anything: where a wheel
// over a tall scroller or document actually lands.
window.__benchVisibleRect = (selector) => {
  const element = window.__benchQuery(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, innerWidth);
  const bottom = Math.min(rect.bottom, innerHeight);
  return right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
};
window.__benchNextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
// count ctrl-wheel notches at (x, y), one every intervalMs, timed in the
// page: see BenchDriver.zoomWheel.
window.__benchZoomWheel = (x, y, deltaY, count, intervalMs) => new Promise((resolve) => {
  let sent = 0;
  const notch = () => {
    document.elementFromPoint(x, y)?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true, ctrlKey: true, clientX: x, clientY: y, deltaY }));
    sent += 1;
    if (sent < count) setTimeout(notch, intervalMs);
    else resolve();
  };
  notch();
});
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What scenarios drive the page with. */
export class BenchDriver {
  constructor(page) {
    this.page = page;
  }

  async install() {
    await this.page.evaluate(PAGE_HELPERS);
  }

  evaluate(expression) {
    return this.page.evaluate(expression);
  }

  async waitFor(expression, { timeout = 30_000, what = expression } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      // Coerced in the page: a DOM node cannot be returned by value.
      const value = await this.page.evaluate(`(() => { const value = (${expression}); return value instanceof Node ? true : value; })()`).catch(() => null);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  async rect(selector, timeout) {
    return this.waitFor(`window.__benchRect(${JSON.stringify(selector)})`, { timeout, what: selector });
  }

  async mouse(type, x, y, extra = {}) {
    await this.page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  }

  async clickAt(x, y) {
    await this.mouse("mouseMoved", x, y, { button: "none" });
    await this.mouse("mousePressed", x, y);
    await this.mouse("mouseReleased", x, y);
  }

  /** The element's rect once it has stopped moving (tree rows animate in when a folder opens). */
  async stableRect(selector) {
    let rect = await this.rect(selector);
    for (;;) {
      await this.nextFrame();
      await sleep(50);
      const next = await this.rect(selector);
      if (next.left === rect.left && next.top === rect.top && next.width === rect.width && next.height === rect.height) return next;
      rect = next;
    }
  }

  async click(selector, { offsetX = 0.5, offsetY = 0.5 } = {}) {
    const rect = await this.stableRect(selector);
    const x = rect.left + rect.width * offsetX;
    const y = rect.top + rect.height * offsetY;
    await this.waitFor(`window.__benchHits(${JSON.stringify(selector)}, ${x}, ${y})`, { what: `${selector} to be uncovered` });
    await this.clickAt(x, y);
  }

  async hover(selector) {
    const rect = await this.rect(selector);
    await this.mouse("mouseMoved", rect.x, rect.y, { button: "none" });
  }

  async nextFrame() {
    await this.page.evaluate("window.__benchNextFrame()");
  }

  async key(character) {
    const [code, keyCode] = KEY_CODES[character]
      ?? [/[a-z]/i.test(character) ? `Key${character.toUpperCase()}` : "", character.toUpperCase().charCodeAt(0)];
    const key = character === "\n" ? "Enter" : character;
    const text = character === "\n" ? "\r" : character;
    await this.page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, text, unmodifiedText: text });
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  }

  /** A key without text, such as Escape. */
  async press(key, code, keyCode) {
    await this.page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode });
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  }

  /**
   * An app shortcut such as Cmd-Shift-P, as a synthetic keydown: headless
   * Chrome never answers a CDP key event that carries Ctrl or Cmd.
   */
  async shortcut(key, { shift = false } = {}) {
    await this.evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, metaKey: true, shiftKey: ${shift}, bubbles: true, cancelable: true }))`);
  }

  /** Types `text` one key at a time at a fixed cadence. */
  async type(text, { pauseMs = KEY_PAUSE_MS } = {}) {
    for (const character of text) {
      await this.key(character);
      await this.nextFrame();
      await sleep(pauseMs);
    }
  }

  /** `count` wheel notches of `deltaY` pixels over the visible middle of the element. */
  async wheel(selector, deltaY, count) {
    const point = await this.waitFor(`window.__benchVisibleRect(${JSON.stringify(selector)})`, { what: selector });
    await this.mouse("mouseMoved", point.x, point.y, { button: "none" });
    for (let index = 0; index < count; index += 1) {
      await this.mouse("mouseWheel", point.x, point.y, { button: "none", deltaX: 0, deltaY });
      await this.nextFrame();
      await sleep(WHEEL_PAUSE_MS);
    }
  }

  /**
   * A ctrl-wheel zoom gesture of `count` notches over the visible middle of the
   * element, one per frame (the cadence of a trackpad pinch, which Chromium
   * reports as ctrl-wheel), then a pause long enough for the zoom to apply.
   *
   * Unlike the other inputs, the notches are dispatched from a timer in the
   * page rather than through CDP: each CDP wheel waits for the renderer to
   * acknowledge it, which under a transformed 200-page preview took 100–350 ms
   * a notch, past the zoom's commit delay, so how many rescales a gesture
   * made depended on the machine. The counts are only comparable when a
   * gesture stays one gesture.
   */
  async zoomWheel(selector, deltaY, count) {
    const point = await this.waitFor(`window.__benchVisibleRect(${JSON.stringify(selector)})`, { what: selector });
    await this.mouse("mouseMoved", point.x, point.y, { button: "none" });
    await this.page.evaluate(`window.__benchZoomWheel(${point.x}, ${point.y}, ${deltaY}, ${count}, ${ZOOM_NOTCH_MS})`);
    await sleep(ZOOM_PAUSE_MS);
  }

  /**
   * Opens a project file from the navigator. Folders it had to expand are
   * collapsed again, so the (virtualized) tree keeps every top-level entry on
   * screen for the next call.
   */
  async openFile(path) {
    const segments = path.split("/");
    const expandedHere = [];
    for (let depth = 1; depth < segments.length; depth += 1) {
      const folder = `${segments.slice(0, depth).join("/")}/`;
      const expanded = await this.evaluate(`window.__benchQuery(${JSON.stringify(treeItem(folder))})?.getAttribute("aria-expanded")`);
      if (expanded !== "true") {
        await this.click(treeItem(folder));
        expandedHere.unshift(folder);
      }
    }
    await this.click(treeItem(path));
    // A click that lands within a few hundred milliseconds of the previous
    // call collapsing a folder can be swallowed by the tree (the driver clicks
    // faster than a person). Setup is unmeasured, so click once more.
    await this.waitForActiveFile(path, 2_000).catch(async () => {
      await this.click(treeItem(path));
      await this.waitForActiveFile(path);
    });
    for (const folder of expandedHere) await this.click(treeItem(folder));
  }

  /** Switches to an already open file through its editor tab. */
  async switchTab(path) {
    await this.markByText('[role="tab"]', path.split("/").pop(), "tab");
    await this.click("[data-bench-tab]");
    await this.waitForActiveFile(path);
  }

  async waitForActiveFile(path, timeout) {
    const name = path.split("/").pop();
    await this.waitFor(
      `[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some((tab) => tab.textContent.trim() === ${JSON.stringify(name)})`,
      { timeout, what: `active tab ${name}` },
    );
  }

  /** Picks Edit, Split or Preview in the document view control. */
  async selectView(view) {
    await this.markByText('[role="tablist"][aria-label="Document view"] [role="tab"]', view, "view");
    await this.click('[data-bench-view]');
    await this.waitFor(`document.querySelector('[data-bench-view]')?.getAttribute("aria-selected") === "true"`, { what: `the ${view} view` });
  }

  /** Tags the element among `selector` whose text is `text`, so it can be clicked by attribute. */
  async markByText(selector, text, tag) {
    await this.waitFor(`(() => {
      document.querySelectorAll("[data-bench-${tag}]").forEach((element) => element.removeAttribute("data-bench-${tag}"));
      const match = [...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(text)});
      match?.setAttribute("data-bench-${tag}", "");
      return Boolean(match);
    })()`, { what: `${text} in ${selector}` });
  }

  /**
   * Waits until nothing has committed or mutated for `quietMs`, so trailing
   * debounced work lands inside the measurement rather than after it. The
   * default outlasts the app's longest idle debounces (a large Markdown
   * document publishes after 1 s, autosave waits 0.9–1.2 s).
   */
  async settle({ quietMs = 1_500, timeout = 20_000 } = {}) {
    const deadline = Date.now() + timeout;
    let last = await this.activity();
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await sleep(100);
      const now = await this.activity();
      if (now !== last) {
        last = now;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= quietMs) return;
    }
  }

  activity() {
    return this.evaluate(`(() => { const s = window.__latticeProbe.snapshot(0); return s.commits + ":" + s.idleCommits + ":" + s.mutations; })()`);
  }
}

const treeItem = (path) => `file-tree-container.lattice-file-tree >>> [data-item-path="${path}"]`;

const EDITOR = ".cm-editor .cm-content";
const VISUAL = ".ProseMirror";

/** Places the caret at the start of the `line`-th visible source line. */
async function caretInSourceLine(driver, line) {
  await driver.click(`${EDITOR} > .cm-line:nth-of-type(${line})`, { offsetX: 0.02 });
}

export const SCENARIOS = [
  {
    name: "startup",
    description: "Load the app and open the fixture project's root document, with its PDF preview.",
    unit: "load",
    steps: 1,
    // Measured from navigation: the runner loads the page inside the measurement.
    startup: true,
  },
  {
    name: "latex-typing",
    description: "Type 40 characters into a LaTeX chapter in the source editor, PDF preview beside it.",
    unit: "keystroke",
    steps: 40,
    async setup(driver) {
      await driver.openFile("chapters/ch01.tex");
      await driver.rect(EDITOR);
      await caretInSourceLine(driver, 12);
    },
    run: (driver) => driver.type("lattice ".repeat(5)),
  },
  {
    name: "long-tex-typing",
    // A long buffer's document-wide work (counts, TODOs, outline, labels)
    // catches up after a pause in typing or after five seconds of continuous
    // typing (app/use-settled-source.ts). 24 keys stay clear of the five-second
    // boundary even on a slow runner, so it catches up exactly once, at the end.
    description: "Type 24 characters into a 3 MB, 18k-line LaTeX file in the source editor, PDF preview beside it.",
    unit: "keystroke",
    steps: 24,
    async setup(driver) {
      await driver.openFile("long.tex");
      await driver.rect(EDITOR);
      await caretInSourceLine(driver, 12);
    },
    run: (driver) => driver.type("lattice ".repeat(3)),
  },
  {
    name: "markdown-source-typing",
    description: "Type 40 characters into the long Markdown document in the source editor.",
    unit: "keystroke",
    steps: 40,
    async setup(driver) {
      await driver.openFile("large.md");
      await driver.selectView("Edit");
      await driver.rect(EDITOR);
      await caretInSourceLine(driver, 10);
    },
    run: (driver) => driver.type("lattice ".repeat(5)),
  },
  {
    name: "markdown-visual-typing",
    // Fewer keys than the source scenarios: a large document publishes after
    // one idle second or five seconds of continuous typing, and 24 keys stay
    // clear of the five-second boundary even on a slow runner, so exactly one
    // publication lands in every run.
    description: "Type 24 characters into a paragraph of the long Markdown document in the visual editor.",
    unit: "keystroke",
    steps: 24,
    async setup(driver) {
      await driver.openFile("large.md");
      await driver.selectView("Preview");
      await driver.click(`${VISUAL} > p:nth-of-type(3)`, { offsetX: 0.02, offsetY: 0.2 });
    },
    run: (driver) => driver.type("lattice ".repeat(3)),
  },
  {
    name: "file-switch",
    description: "Switch between main.tex, large.md, a note and a chapter through their editor tabs (split view).",
    unit: "switch",
    steps: 4,
    async setup(driver) {
      await driver.openFile("large.md");
      await driver.openFile("notes/note-000.md");
      await driver.openFile("chapters/ch01.tex");
      await driver.openFile("main.tex");
    },
    async run(driver) {
      for (const path of ["large.md", "notes/note-000.md", "chapters/ch01.tex", "main.tex"]) {
        await driver.switchTab(path);
        await driver.settle({ quietMs: 300 });
      }
    },
  },
  {
    name: "code-highlight",
    // The first open also loads the visual editor's modules and grammars, and
    // when that lands varies from run to run; setup pays it, so the measured
    // switch renders and highlights the document with everything loaded.
    description: "Switch to a document of 150 highlighted code blocks in the visual editor, then type 20 characters into one.",
    unit: "action",
    steps: 21,
    async setup(driver) {
      await driver.openFile("code.md");
      await driver.selectView("Preview");
      await driver.rect(`${VISUAL} pre code`);
      await driver.openFile("main.tex");
    },
    async run(driver) {
      await driver.switchTab("code.md");
      await driver.rect(`${VISUAL} pre code`);
      await driver.settle({ quietMs: 400 });
      await driver.click(`${VISUAL} pre code`, { offsetX: 0.9, offsetY: 0.1 });
      await driver.type("x = 1; y = 2; z = 34", { pauseMs: PUBLISH_PAUSE_MS });
    },
  },
  {
    name: "pdf-open",
    description: "Open a 200-page PDF from the navigator and let it render.",
    unit: "open",
    steps: 1,
    async setup(driver) {
      await driver.openFile("notes/note-000.md");
    },
    async run(driver) {
      await driver.openFile("reference.pdf");
      await driver.waitFor(`document.querySelectorAll(".pdfViewer .page canvas, .pdfViewer .page img").length > 0`, { what: "a rendered PDF page" });
    },
  },
  {
    name: "pdf-scroll",
    description: "Scroll the compiled 200-page PDF preview by 40 wheel notches.",
    unit: "notch",
    steps: 40,
    async setup(driver) {
      await driver.waitFor(`document.querySelectorAll(".pdfViewer .page canvas").length > 0`, { what: "the PDF preview" });
    },
    run: (driver) => driver.wheel(".pdf-preview .pdf-scroll-area-viewport", 120, 40),
  },
  {
    name: "pdf-zoom",
    description: "Zoom the compiled 200-page PDF preview in, out and in again with three 10-notch ctrl-wheel gestures.",
    unit: "notch",
    steps: 30,
    async setup(driver) {
      await driver.waitFor(`document.querySelectorAll(".pdfViewer .page canvas").length > 0`, { what: "the PDF preview" });
    },
    async run(driver) {
      for (const deltaY of [-8, 8, -8]) await driver.zoomWheel(".pdf-preview .pdf-scroll-area-viewport", deltaY, 10);
    },
  },
  {
    name: "source-scroll",
    description: "Scroll a LaTeX chapter in the source editor by 40 wheel notches.",
    unit: "notch",
    steps: 40,
    async setup(driver) {
      await driver.openFile("chapters/ch02.tex");
      await driver.rect(EDITOR);
    },
    run: (driver) => driver.wheel(".cm-editor .cm-scroller", 120, 40),
  },
  {
    name: "markdown-preview-scroll",
    description: "Scroll the long Markdown document in the visual editor by 40 wheel notches.",
    unit: "notch",
    steps: 40,
    async setup(driver) {
      await driver.openFile("large.md");
      await driver.selectView("Preview");
      await driver.rect(VISUAL);
    },
    run: (driver) => driver.wheel(".markdown-preview .editor-doc-scroll", 120, 40),
  },
  {
    name: "dialog-open",
    // A dialog must not restyle the whole document on open: with the long
    // document's visual editor on screen, Radix's modal mode (pointer-events
    // on body, a scroll-lock stylesheet, aria-hidden on every sibling) cost
    // WebKit 1.2-1.5 s per open (components/ui/modal-dialog.tsx).
    description: "Open the command palette over the long Markdown document in the visual editor, then close it with Escape, 4 times.",
    unit: "open",
    steps: 4,
    async setup(driver) {
      await driver.openFile("large.md");
      await driver.selectView("Preview");
      await driver.rect(VISUAL);
    },
    async run(driver) {
      for (let index = 0; index < 4; index += 1) {
        await driver.shortcut("P", { shift: true });
        await driver.waitFor(`document.querySelector(".modal-dialog-content")`, { what: "the command palette" });
        await driver.nextFrame();
        await driver.settle({ quietMs: 300 });
        await driver.press("Escape", "Escape", 27);
        await driver.waitFor(`!document.querySelector(".modal-dialog-content")`, { what: "the palette to close" });
        await driver.nextFrame();
        await driver.settle({ quietMs: 300 });
      }
    },
  },
  {
    name: "compile",
    description: "Build the project, then expand the diagnostics and show the 4,000-line compile log.",
    unit: "build",
    steps: 1,
    async setup(driver) {
      await driver.waitFor(`document.querySelector(${JSON.stringify(BUILD_BUTTON)})`, { what: "the Build button" });
    },
    async run(driver) {
      const builds = await driver.evaluate(`window.__latticeBench?.counts.get("build_project") ?? 0`);
      await driver.click(BUILD_BUTTON);
      await driver.waitFor(`(window.__latticeBench?.counts.get("build_project") ?? 0) > ${builds} && document.querySelector(${JSON.stringify(BUILD_BUTTON)})`, { what: "the build to finish" });
      await driver.settle({ quietMs: 300 });
      await driver.click(".compile-diagnostics-toggle");
      await driver.markByText('.compile-diagnostics-tabs [role="tab"]', "Log", "log");
      await driver.click("[data-bench-log]");
      await driver.rect(".compile-log");
    },
  },
];
