// The App screens: how each is staged on the mock-backend page (docs/driving-the-app.md)
// before draw.mjs turns it into Paper layers. Every scene opens the bundled
// tutorial project, widens the file sidebar so no entry is truncated, and parks
// the pointer outside the window so nothing is drawn hovered.
import { chromium } from "playwright-core";

/** Artboard rows on the App screens page, top to bottom: [scene, label]. */
export const SCREENS = [
  ["mainWindow", "Main window"],
  ["agent", "Agent panel"],
  ["refLibrary", "References · library"],
  ["refEntry", "References · entry"],
  ["refAddArxiv", "References · add from arXiv"],
  ["markdown", "Markdown"],
  ["html", "HTML"],
  ["slides", "Slides"],
  ["settings", "Settings"],
  ["welcome", "Welcome"],
];

// Staging artefacts, not part of the screen: the dirty dot the sidebar drag leaves on the Workspace tab.
const SKIP = [".trellis-workspace-dirty"];

async function open(env, theme, query, ready = ".cm-content") {
  const browser = await chromium.launch();
  // Reduced motion: each screen at rest, nothing caught mid-animation (the welcome field's pulses, a spinner).
  // Paper draws at 1440×900 @1x; the GPUI parity harness asks for the GPUI window's size and scale (env.viewport, env.deviceScaleFactor).
  const viewport = env.viewport ?? { width: 1440, height: 900 };
  const page = await browser.newPage({ viewport, deviceScaleFactor: env.deviceScaleFactor ?? 1, reducedMotion: "reduce" });
  await page.goto(`${env.benchUrl.split("?")[0]}?theme=${theme}&lang=en${query ? `&${query}` : ""}`);
  await page.waitForSelector(ready, { timeout: 60_000 });
  await page.waitForTimeout(800);
  return { browser, page, skip: SKIP };
}

async function rest(page, ms = 2000) {
  await page.mouse.move(1435, 895);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(ms);
}

const drag = async (page, from, to) => {
  await page.mouse.move(...from); await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 6 }); await page.mouse.move(...to, { steps: 6 });
  await page.mouse.up();
};

async function project(env, theme, extra = "") {
  const pdf = env.pdfUrl ? `&pdf=${env.pdfUrl}` : "";
  const staged = await open(env, theme, `tutorial=1&build=clean${pdf}${extra}`);
  const notNow = staged.page.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.click();
  await drag(staged.page, [284, 300], [344, 300]);
  await rest(staged.page);
  return staged;
}

/** Run a command from the ⌘K palette by its label. */
const palette = async (page, label) => {
  await page.keyboard.press("Meta+k");
  await page.keyboard.type(label);
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
};
const openFile = async (page, path) => { await page.locator(`[data-item-path="${path}"]`).click(); await page.waitForTimeout(1500); };
const viewMode = (page, mode) => page.locator(`button.ui-segmented-tab[title=${mode}]`).click();

export const scenes = {
  mainWindow: (env, theme) => project(env, theme),
  async agent(env, theme) {
    const staged = await project(env, theme);
    const { page } = staged;
    // A taller, wider Agent group: Papers down to the bottom third, the sidebar to 420px.
    await drag(page, [175, 569], [175, 760]);
    await drag(page, [344, 300], [424, 300]);
    await page.getByRole("tab", { name: "Agent" }).first().click();
    await rest(page, 2500);
    // Synara's frame cannot run here: agent.mjs renders it, and draw.mjs puts it in this slot.
    staged.inject = { ".synara-frame-shell": "agent" };
    return staged;
  },
  async refLibrary(env, theme) {
    const staged = await project(env, theme, "&papers=library");
    await openFile(staged.page, "references.bib");
    await viewMode(staged.page, "Preview");
    await rest(staged.page);
    return staged;
  },
  async refEntry(env, theme) {
    const staged = await scenes.refLibrary(env, theme);
    await staged.page.getByText("Attention Is All You Need", { exact: true }).last().click();
    await rest(staged.page);
    return staged;
  },
  async refAddArxiv(env, theme) {
    const staged = await scenes.refLibrary(env, theme);
    await staged.page.getByRole("button", { name: "Add papers…" }).click();
    await staged.page.waitForTimeout(600);
    await staged.page.locator("textarea").first().fill("https://arxiv.org/abs/1706.03762");
    await rest(staged.page, 3000);
    return staged;
  },
  async markdown(env, theme) {
    const staged = await project(env, theme);
    await openFile(staged.page, "notes.md");
    await viewMode(staged.page, "Preview");
    await rest(staged.page);
    return staged;
  },
  async html(env, theme) {
    const staged = await project(env, theme);
    await openFile(staged.page, "attention-demo.html");
    await rest(staged.page, 3000);
    return staged;
  },
  // The tutorial's spreadsheet and board, for the GPUI parity report
  // (gpui/parity/regions.mjs); not App screens artboards.
  async sheet(env, theme) {
    const staged = await project(env, theme);
    await openFile(staged.page, "attention-results.lattice-sheet");
    await staged.page.waitForSelector(".spreadsheet-univer-host canvas", { timeout: 30_000 });
    await rest(staged.page, 3000);
    return staged;
  },
  async board(env, theme) {
    const staged = await project(env, theme);
    await openFile(staged.page, "attention-map.tldr");
    await staged.page.waitForSelector(".board-editor-root .tl-shape", { timeout: 30_000 });
    await rest(staged.page, 3000);
    return staged;
  },
  async slides(env, theme) {
    const staged = await project(env, theme);
    if (env.slides) {
      // The mock backend has no Open Slide host: lease the deck from the runtime draw.mjs started.
      await staged.page.evaluate(({ origin, token, control }) => {
        const internals = window.__TAURI_INTERNALS__;
        const real = internals.invoke.bind(internals);
        internals.invoke = (cmd, args, options) => {
          if (cmd === "presentation_ensure_ready") {
            return Promise.resolve({ state: "ready", projectRoot: args?.projectRoot ?? null, origin, sessionUrl: `${origin}/__lattice/bootstrap?token=${token}`, controlToken: control, leaseId: "design-system" });
          }
          if (cmd === "presentation_release" || cmd === "presentation_refresh_native_workspace") return Promise.resolve(null);
          return real(cmd, args, options);
        };
      }, { origin: env.slides.origin, token: env.slides.token, control: env.slides.control });
    }
    await openFile(staged.page, "slides/understanding-attention/");
    await openFile(staged.page, "slides/understanding-attention/index.tsx");
    await rest(staged.page, 12_000);
    return staged;
  },
  async settings(env, theme) {
    const staged = await project(env, theme);
    await staged.page.keyboard.press("Meta+Comma");
    await staged.page.waitForSelector(".settings-modal", { timeout: 30_000 });
    await rest(staged.page, 4000);
    return staged;
  },
  // History opened from the titlebar on the paper's versions (`?versions=compare`,
  // tools/perf-bench/bench-compare.ts). The parity harness's screens only;
  // not on the App screens page.
  async history(env, theme) {
    const staged = await project(env, theme, "&versions=compare");
    await staged.page.getByRole("button", { name: "Project history" }).click();
    await staged.page.waitForSelector(".history-row", { timeout: 30_000 });
    await rest(staged.page);
    return staged;
  },
  async historyCompare(env, theme) {
    const staged = await scenes.history(env, theme);
    await staged.page.getByRole("button", { name: "Compare…" }).click();
    await staged.page.waitForSelector(".compare-passage", { timeout: 30_000 });
    await rest(staged.page);
    return staged;
  },
  // Manuscript TODOs from the palette: the tutorial has none, so the empty
  // state. The parity harness's screens only; not on the App screens page.
  async todos(env, theme) {
    const staged = await project(env, theme);
    await palette(staged.page, "Manuscript TODOs");
    await staged.page.waitForSelector(".todo-empty", { timeout: 30_000 });
    await rest(staged.page);
    return staged;
  },
  // Export for arXiv… with the bench's checked pack (`?arxiv=ready`,
  // tools/perf-bench/bench-arxiv.ts), once its test build has answered.
  async arxivExport(env, theme) {
    const staged = await project(env, theme, "&arxiv=ready");
    await palette(staged.page, "Export for arXiv…");
    await staged.page.waitForSelector('.arxiv-export-checks [data-check="compile"][data-state="ok"]', { timeout: 30_000 });
    await rest(staged.page);
    return staged;
  },
  // "Open from Overleaf" on an account with five projects
  // (`?overleaf=picker`, tools/perf-bench/bench-overleaf.ts), the newest
  // chosen so its Open buttons show. The parity harness's screens only.
  async overleafPicker(env, theme) {
    const staged = await project(env, theme, "&overleaf=picker");
    await staged.page.locator('button[data-tour="overleaf"]').click();
    await staged.page.waitForSelector(".overleaf-project-row", { timeout: 30_000 });
    await staged.page.locator(".overleaf-project-main").first().click();
    await rest(staged.page);
    return staged;
  },
  // Settings › Overleaf with the tutorial linked and live (`?overleaf=review`).
  async settingsOverleaf(env, theme) {
    const staged = await project(env, theme, "&overleaf=review");
    await staged.page.keyboard.press("Meta+Comma");
    await staged.page.waitForSelector(".settings-modal", { timeout: 30_000 });
    await staged.page.locator(".settings-nav-group > button", { hasText: "Overleaf" }).click();
    await staged.page.waitForSelector('[data-setting="overleaf-sync-mode"]', { timeout: 30_000 });
    await rest(staged.page, 4000);
    return staged;
  },
  async welcome(env, theme) {
    const staged = await open(env, theme, "welcome=1&recents=1", ".welcome-screen");
    await rest(staged.page, 1500);
    return staged;
  },
};
