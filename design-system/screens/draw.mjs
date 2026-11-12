#!/usr/bin/env node
// Draws the app's main screens into the Paper file's App screens page as
// editable layers bound to the design-system tokens (design-system/README.md,
// "App screens"). Each screen is staged on the mock-backend page (scenes.mjs),
// serialized by serialize.js in the page and in each of its frames, and
// written to an artboard named "<screen> · <theme>", replacing the one of that
// name in place.
//
//   pnpm perf:bench --serve --dev --port 0          # in another shell; prints the URL
//   BENCH_URL=<url> node design-system/screens/draw.mjs [screen…] [--theme light,dark] [--out DIR] [--dry-run]
//
// With no screen named, every screen in scenes.mjs is drawn. --dry-run writes
// the HTML to --out (default $TMPDIR/lattice-app-screens) without touching
// Paper. The tutorial's PDF is built with latexmk when it is on PATH (else the
// bench's fixture PDF shows); slides need tools/open-slide-runtime installed
// (`pnpm --dir tools/open-slide-runtime install`); the Agent panel needs
// agent.mjs to have rendered Synara first, or its slot stays empty.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../paper.mjs";
import { tokenOptions } from "./options.mjs";
import { scenes, SCREENS } from "./scenes.mjs";
import { servePdf, TUTORIAL_TEMPLATE } from "./tutorial.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const themes = flag("--theme", "light,dark").split(",");
const out = flag("--out", join(tmpdir(), "lattice-app-screens"));
const dryRun = args.includes("--dry-run") && args.splice(args.indexOf("--dry-run"), 1);
const wanted = args.length ? args : SCREENS.map(([scene]) => scene);
for (const scene of wanted) if (!scenes[scene]) throw new Error(`no screen ${scene}; screens: ${SCREENS.map(([s]) => s).join(", ")}`);
if (!process.env.BENCH_URL) throw new Error("set BENCH_URL to the mock-backend page (pnpm perf:bench --serve)");
mkdirSync(join(out, "assets"), { recursive: true });

// ---------------------------------------------------------------- what the scenes need

/** The tutorial's own PDF, built in a scratch copy and served with CORS for the page's ?pdf=. */
function tutorialPdf() {
  const dir = join(out, "tutorial");
  rmSync(dir, { recursive: true, force: true });
  cpSync(TUTORIAL_TEMPLATE, dir, { recursive: true });
  cpSync(join(repo, "src-tauri/templates/neurips-2026/neurips_2026.sty"), join(dir, "neurips.sty"));
  try {
    execFileSync("latexmk", ["-pdf", "-interaction=nonstopmode", "main.tex"], { cwd: dir, stdio: "ignore", timeout: 300_000 });
  } catch {
    if (!existsSync(join(dir, "main.pdf"))) return null;
  }
  return servePdf(join(dir, "main.pdf"));
}

/** Open Slide over a throwaway copy of the tutorial deck, as the native host would start it. */
function slideRuntime() {
  const runtime = join(repo, "tools/open-slide-runtime");
  const pinned = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).dependencies["@open-slide/core"];
  const installed = join(runtime, "node_modules/@open-slide/core/package.json");
  if (!existsSync(installed) || JSON.parse(readFileSync(installed, "utf8")).version !== pinned) {
    return Promise.reject(new Error(`install @open-slide/core ${pinned} first: pnpm --dir tools/open-slide-runtime install`));
  }
  const root = join(out, "slides-runtime");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "workspace"), { recursive: true });
  cpSync(join(repo, "src-tauri/templates/tutorial/slides"), join(root, "workspace/slides"), { recursive: true });
  const control = "design-system-screens";
  const child = spawn(process.execPath, [join(repo, "tools/open-slide-runtime/server.mjs")], {
    cwd: join(root, "workspace"),
    env: { ...process.env, OPEN_SLIDE_SHADOW_ROOT: join(root, "workspace"), OPEN_SLIDE_CONTROL_TOKEN: control, OPEN_SLIDE_CACHE_ROOT: join(root, "cache") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n")[0];
      if (!buffer.includes("\n")) return;
      const ready = JSON.parse(line);
      resolve({ origin: `http://127.0.0.1:${ready.port}`, token: ready.sessionToken, control, close: () => child.kill() });
    });
    child.once("exit", (code) => reject(new Error(`Open Slide exited with ${code}`)));
  });
}

// ---------------------------------------------------------------- serialize

const serializer = readFileSync(join(here, "serialize.js"), "utf8");

async function draw(scene, theme, env) {
  const staged = await scenes[scene](env, theme);
  const options = { ...tokenOptions(theme), rootSelector: "body", skipSelectors: staged.skip ?? [], names: {}, inject: staged.inject ?? {} };
  let imageCount = 0;
  const unmapped = {};
  const saveImages = (html, images) => {
    for (const image of images) {
      const file = join(out, "assets", `${scene}-${theme}-${imageCount++}.png`);
      writeFileSync(file, Buffer.from(image.data.split(",")[1], "base64"));
      html = html.replaceAll(`"__${image.id}__"`, `"paper-asset://${file}"`);
    }
    return html;
  };
  const inFrame = async (frame) => {
    const result = await frame.evaluate(`(${serializer})(${JSON.stringify(options)})`);
    for (const [color, count] of Object.entries(result.stats.unmapped)) unmapped[color] = (unmapped[color] ?? 0) + count;
    let html = saveImages(result.html, result.images);
    for (const slot of result.frames) {
      let inner = "", background = "";
      for (const child of frame.childFrames()) {
        const box = await (await child.frameElement().catch(() => null))?.boundingBox();
        if (!box || Math.abs(box.x - slot.x) > 1.5 || Math.abs(box.y - slot.y) > 1.5) continue;
        await child.waitForLoadState("load").catch(() => {});
        const sub = await inFrame(child);
        inner = sub.html;
        background = [sub.background && `background-color:${sub.background}`, sub.backgroundImage && `background-image:${sub.backgroundImage}`].filter(Boolean).join(";");
        break;
      }
      html = html.replace(`__FRAME_${slot.k}__`, inner).replace(`__FRAMEBG_${slot.k}__`, background);
    }
    for (const slot of result.injected) {
      const file = join(out, `${slot.key}-${theme}.json`);
      let inner = "";
      if (existsSync(file)) {
        const rendered = JSON.parse(readFileSync(file, "utf8"));
        inner = `<div layer-name="${slot.key}" style="position:absolute;left:0px;top:0px;width:100%;height:100%;display:flex;background-color:${rendered.background}">${saveImages(rendered.html, rendered.images)}</div>`;
      } else console.warn(`${scene} ${theme}: no ${file}; run agent.mjs to fill the ${slot.key} slot`);
      html = html.replace(`__INJECT_${slot.key}__`, inner);
    }
    return { html, background: result.background, backgroundImage: result.backgroundImage, width: result.width, height: result.height };
  };
  try {
    const drawn = await inFrame(staged.page.mainFrame());
    writeFileSync(join(out, `${scene}-${theme}.html`), drawn.html);
    return { ...drawn, unmapped };
  } finally {
    await staged.browser.close();
  }
}

// ---------------------------------------------------------------- Paper

async function appScreensPage(paper) {
  const info = await paper.call("get_basic_info", {});
  const page = info.pages.find((entry) => entry.type === "page" && entry.name === "App screens");
  return page ? page.id : (await paper.call("create_page", { name: "App screens", icon: "images" })).pageId;
}

const env = { benchUrl: process.env.BENCH_URL };
const pdf = await tutorialPdf();
if (pdf) env.pdfUrl = pdf.url; else console.warn("latexmk failed or is missing: the PDF pane shows the bench's fixture");
const slides = wanted.includes("slides") ? await slideRuntime().catch((error) => { console.warn(`slides: ${error.message}`); return null; }) : null;
if (slides) env.slides = slides;
const paper = dryRun ? null : await connect();
try {
  const pageId = paper && await appScreensPage(paper);
  for (const scene of wanted) {
    const row = SCREENS.findIndex(([name]) => name === scene);
    const label = SCREENS[row][1];
    for (const theme of themes) {
      const drawn = await draw(scene, theme, env);
      const name = `${label} · ${theme}`;
      const unmapped = Object.keys(drawn.unmapped).length;
      if (!paper) { console.log(`${name}: ${join(out, `${scene}-${theme}.html`)} (${unmapped} colours match no token)`); continue; }
      const { artboards } = await paper.call("get_basic_info", { pageId });
      const old = artboards.find((board) => board.name === name);
      if (old) await paper.call("delete_nodes", { nodeIds: [old.id] });
      const styles = {
        width: `${drawn.width}px`, height: `${drawn.height}px`, display: "flex", position: "relative", overflow: "hidden",
        backgroundColor: drawn.background ?? "#FFFFFF",
      };
      const created = await paper.call("create_artboard", { pageId, name, styles });
      const id = created.id ?? created.nodeId;
      // A grid: one row per screen, light then dark. create_artboard places by itself; top and left move it.
      await paper.call("update_styles", { updates: [{ nodeIds: [id], styles: { left: `${theme === "dark" ? 1520 : 0}px`, top: `${row * 1000}px` } }] });
      const written = await paper.call("write_html", { targetNodeId: id, mode: "insert-children", html: drawn.html });
      if (!written?.createdNodes?.length) throw new Error(`${name}: Paper wrote nothing (${JSON.stringify(written).slice(0, 200)})`);
      console.log(`${name}: drawn (${unmapped} colours match no token)`);
    }
  }
  if (paper) await paper.call("finish_working_on_nodes", {});
} finally {
  paper?.close();
  pdf?.close();
  slides?.close();
}
