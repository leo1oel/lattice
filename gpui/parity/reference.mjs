// The reference side of the parity diff: the Tauri app's frontend on the
// mock-backend page (pnpm perf:bench --serve), staged by the same scene
// functions that draw Paper's App screens (design-system/screens/scenes.mjs),
// at the GPUI window's size and scale. It writes, per run:
//
//   <name>.png         the viewport, at the device scale
//   <name>.json        the named regions' bounds and the styles of their runs
//                      of text, every run of text's box, and the content
//                      regions' boxes
//   <name>.paper.html  the page as serialize.js draws it into Paper, its
//                      layers named after the regions (the layout record the
//                      App screens page is made from)
//
// A run's family is the face Chrome actually drew it in
// (CSS.getPlatformFontsForNode), not the first name in its CSS stack.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenOptions } from "../../design-system/screens/options.mjs";
import { scenes } from "../../design-system/screens/scenes.mjs";
import { measureInPage, SCREENS } from "./regions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serializer = readFileSync(join(here, "../../design-system/screens/serialize.js"), "utf8");

/**
 * The face that drew most of each tagged element's glyphs, by tag. An
 * input's text is in its user-agent shadow root, so the element asked about
 * is the first one, the tagged element or below it, with a text node of
 * its own.
 */
async function platformFonts(page, tags) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const below = (node) => [...(node.shadowRoots ?? []), ...(node.children ?? [])];
  const holder = (node) => ((node.children ?? []).some((child) => child.nodeType === 3 && child.nodeValue.trim())
    ? node
    : below(node).map(holder).find(Boolean) ?? null);
  const tagged = new Map();
  const walk = (node) => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === "data-parity-text") tagged.set(attrs[i + 1], holder(node) ?? node);
    for (const child of below(node)) walk(child);
  };
  walk(root);
  const fonts = {};
  for (const tag of tags) {
    const node = tagged.get(tag);
    if (!node) continue;
    const { fonts: used } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
    const main = used.sort((a, b) => b.glyphCount - a.glyphCount)[0];
    if (main) fonts[tag] = main.familyName;
  }
  await cdp.detach();
  return fonts;
}

/**
 * Stage `screen` in `theme` and record it as `<dir>/<name>.*`.
 * env: { benchUrl, pdfUrl, viewport: {width, height}, deviceScaleFactor }.
 */
export async function captureReference(screen, theme, env, dir, name) {
  const spec = SCREENS[screen];
  const staged = await scenes[screen](env, theme);
  const { page } = staged;
  try {
    const measured = await page.evaluate(measureInPage, { regions: spec.regions, content: spec.content });
    const runs = Object.values(measured.regions).flatMap((region) => region?.texts ?? []);
    const fonts = await platformFonts(page, new Set(runs.map((run) => run.tag)));
    for (const run of runs) run.family = fonts[run.tag];
    await page.screenshot({ path: join(dir, `${name}.png`) });
    const names = Object.fromEntries(spec.regions.map((r) => [`[data-parity-region="${r.name}"]`, r.name]));
    const options = { ...tokenOptions(theme), rootSelector: "body", skipSelectors: staged.skip ?? [], names, inject: {} };
    const drawn = await page.evaluate(`(${serializer})(${JSON.stringify(options)})`);
    // Frames and images stay empty slots here: the layout is what this file is for.
    writeFileSync(join(dir, `${name}.paper.html`), drawn.html.replace(/__FRAME(BG)?_\d+__/g, ""));
    const record = {
      screen, theme, viewport: env.viewport, scale: env.deviceScaleFactor,
      ...measured,
    };
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(record, null, 2));
    return record;
  } finally {
    await staged.browser.close();
  }
}
