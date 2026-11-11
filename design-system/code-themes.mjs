#!/usr/bin/env node
// Exports the source editors' code themes into code-themes.json, for the GPUI
// app (gpui/crates/lattice-ui generates its Zed editor themes from it and
// fails a test while the two disagree).
//
//   node design-system/code-themes.mjs           write code-themes.json
//   node design-system/code-themes.mjs --check   exit 1 while it is stale
//
// The values are not copied: this imports the app's own modules
// (src/settings/code-themes.ts and theme-customization.ts, which it imports)
// and records what codeThemeProperties returns, so every token is the fitted
// colour the app paints, under the same contrast rules. Node runs the
// TypeScript itself by stripping its types (Node 22.18 and later do by
// default), and the hook below lets the app's extensionless `./x` imports
// find their `.ts` files, so this needs no install.
//
// `order` lists every theme's id as Settings lists them, Weft & Warp's
// (`lattice`) included. For each theme but Weft & Warp, whose colours are
// design tokens already (tokens.json, `--lattice-*`), and each app
// appearance, the export holds the variant the editor shows (`resolveCodeThemeKind(theme, "auto", app)`),
// whether it stands on the window's editor ground (the variant in the app's
// own appearance) or its own, and the properties themselves, verbatim: the
// sixteen `--syntax-*` roles and every `--code-*` value. A variant on the
// window writes its ground as `var(--editor-bg)` and its current line and
// selections as `color-mix()` of a colour over it, which is the colour at an
// alpha; one on its own ground writes opaque colours.
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript || !registerHooks) {
  throw new Error(`code-themes.mjs needs Node 22.18 or later, which runs TypeScript; this is ${process.version}`);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith(".ts")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "code-themes.json");

const { CODE_THEMES, codeThemeName, codeThemeKinds, resolveCodeThemeKind, codeThemeProperties } =
  await import("../src/settings/code-themes.ts");

const APPEARANCES = ["light", "dark"];

function render() {
  const themes = CODE_THEMES.filter((theme) => theme !== "lattice").map((theme) => ({
    id: theme,
    name: codeThemeName(theme),
    kinds: codeThemeKinds(theme),
    apps: Object.fromEntries(APPEARANCES.map((app) => {
      const kind = resolveCodeThemeKind(theme, "auto", app);
      const properties = codeThemeProperties(theme, kind, app);
      return [app, {
        kind,
        ground: kind === app ? "window" : "own",
        properties: Object.fromEntries(Object.keys(properties).sort().map((name) => [name, properties[name]])),
      }];
    })),
  }));
  return `${JSON.stringify({
    about: "Generated from src/settings/code-themes.ts by design-system/code-themes.mjs. Do not edit.",
    order: CODE_THEMES,
    themes,
  }, null, 2)}\n`;
}

const json = render();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
  } catch {
    // Missing reads as stale.
  }
  if (current !== json) {
    console.error("design-system/code-themes.json disagrees with src/settings/code-themes.ts; run `node design-system/code-themes.mjs`.");
    process.exit(1);
  }
  console.log("design-system/code-themes.json matches src/settings/code-themes.ts.");
} else {
  writeFileSync(OUT, json);
  console.log("wrote design-system/code-themes.json");
}
