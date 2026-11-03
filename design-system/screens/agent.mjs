#!/usr/bin/env node
// Renders the Agent panel for the App screens. The panel is Synara's own web
// app in a frame the mock-backend page cannot run, so this renders Synara's
// real chat view in its browser test harness instead: in Lattice's embed mode
// (chrome surface), painted with the host theme Lattice posts to it, at the
// size of the Agent slot in the staged window, with a short editing turn. The
// harness serializes it with serialize.js and draw.mjs puts it in the slot.
//
//   BENCH_URL=<url> node design-system/screens/agent.mjs <synara checkout> [--out DIR]
//
// The checkout is Synara at the revision scripts/synara-runtime.json pins, with
// its dependencies installed (`bun install`). This adds a test file and a
// lattice-screens/ folder to it while it runs and removes both afterwards.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenOptions } from "./options.mjs";
import { scenes } from "./scenes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const out = flag("--out", join(tmpdir(), "lattice-app-screens"));
const synara = args[0] && resolve(args[0]);
if (!synara || !existsSync(join(synara, "apps/web/src/components/ChatView.browser.tsx"))) throw new Error("pass a Synara checkout (apps/web/src/components/ChatView.browser.tsx)");
if (!process.env.BENCH_URL) throw new Error("set BENCH_URL to the mock-backend page (pnpm perf:bench --serve)");
mkdirSync(out, { recursive: true });

const web = join(synara, "apps/web");
const inputs = join(web, "lattice-screens");
const testFile = join(web, "src/components/LatticeScreens.browser.tsx");
mkdirSync(inputs, { recursive: true });
try {
  // The slot and the host theme, from the staged window in each theme.
  for (const theme of ["light", "dark"]) {
    const staged = await scenes.agent({ benchUrl: process.env.BENCH_URL }, theme);
    const { slot, hostTheme } = await staged.page.evaluate(async (appTheme) => {
      const { readAgentHostTheme } = await import("/src/agent/agent-host-theme.ts");
      const r = document.querySelector(".synara-frame-shell").getBoundingClientRect();
      return {
        slot: { w: r.width, h: r.height },
        hostTheme: readAgentHostTheme({ theme: appTheme, tint: "graphite", accent: "graphite", translucency: "off", translucent: false }),
      };
    }, theme);
    await staged.browser.close();
    writeFileSync(join(inputs, "slot.json"), JSON.stringify(slot));
    writeFileSync(join(inputs, `host-theme-${theme}.json`), JSON.stringify(hostTheme));
    writeFileSync(join(inputs, `opts-${theme}.json`), JSON.stringify({ ...tokenOptions(theme), rootSelector: "body", skipSelectors: [], names: {}, inject: {} }));
  }
  writeFileSync(join(inputs, "serialize.js"), readFileSync(join(here, "serialize.js"), "utf8"));

  // The harness test: Synara's ChatView suite with ours after its shared hooks.
  const suite = readFileSync(join(web, "src/components/ChatView.browser.tsx"), "utf8");
  const hooks = suite.indexOf("  afterEach(async () => {");
  const after = suite.indexOf("\n  });\n", hooks) + "\n  });\n".length;
  if (hooks < 0 || after < hooks) throw new Error("ChatView.browser.tsx no longer has the afterEach this inserts after");
  writeFileSync(testFile, `${suite.slice(0, after)}\n${readFileSync(join(here, "agent-test.tsx.txt"), "utf8")}${suite.slice(after)}`);

  const env = { ...process.env };
  delete env.BUN_OPTIONS;
  execFileSync(process.execPath, [join(synara, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.browser.config.ts", testFile, "-t", "lattice screens agent"], { cwd: web, env, stdio: "inherit", timeout: 900_000 });
  for (const theme of ["light", "dark"]) {
    writeFileSync(join(out, `agent-${theme}.json`), readFileSync(join(inputs, `agent-${theme}.json`)));
    console.log(`Agent panel · ${theme}: ${join(out, `agent-${theme}.json`)}`);
  }
} finally {
  rmSync(testFile, { force: true });
  rmSync(inputs, { recursive: true, force: true });
}
