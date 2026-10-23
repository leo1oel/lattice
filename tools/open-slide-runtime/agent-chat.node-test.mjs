import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createViteConfig } from "@open-slide/core/vite";
import { transform as transformTsx } from "esbuild";
import { createServer as createViteServer } from "vite";
import { OPEN_SLIDE_CONFIG, transformOpenSlideAgentEntryPoints } from "./agent-chat.mjs";

const CORE = "node_modules/@open-slide/core/";

/** Apply the patch to a pinned Open Slide module, addressed as the runtime's dev server sees it. */
async function patchCore(relative) {
  const source = await readFile(new URL(`./${CORE}${relative}`, import.meta.url), "utf8");
  return { source, transformed: transformOpenSlideAgentEntryPoints(source, `/runtime/${CORE}${relative}?direct`) };
}

test("offers no entry point to Open Slide's own agent panel", async () => {
  const [slide, menu] = await Promise.all([
    patchCore("src/app/routes/slide.tsx"),
    patchCore("src/app/components/command/slide-command-menu.tsx"),
  ]);
  assert.match(slide.source, /<AgentToggleButton \/>/);
  assert.doesNotMatch(slide.transformed, /<AgentToggleButton \/>|onClick=\{toggleAgent\}|e\.key === 'a'/);
  assert.doesNotMatch(menu.transformed, /id: 'agent-panel'|onToggleAgentPanel,/);
  // The design panel's shortcut and command remain.
  assert.match(slide.transformed, /e\.key === 'd'/);
  assert.match(menu.transformed, /id: 'design-panel'/);
  assert.equal(transformOpenSlideAgentEntryPoints(slide.source, "/project/slides/talk/index.tsx"), null);
  await transformTsx(slide.transformed, { loader: "tsx" });
  await transformTsx(menu.transformed, { loader: "tsx" });
});

test("never starts an agent from the runtime's dev server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-agent-"));
  const config = await createViteConfig({ userCwd: root, mode: "serve", config: OPEN_SLIDE_CONFIG });
  const vite = await createViteServer({
    ...config,
    configFile: false,
    logLevel: "silent",
    cacheDir: path.join(root, ".vite"),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  const server = http.createServer(vite.middlewares);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await fetch(`${origin}/__agent/status`).then((response) => response.json());
    assert.deepEqual(status, { enabled: false, packageManager: "", providers: [] });
    const install = await fetch(`${origin}/__agent/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude" }),
    });
    assert.equal(install.status, 404);
    assert.equal((await fetch(`${origin}/__agent/sessions`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  }
});
