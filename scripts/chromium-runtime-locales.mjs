import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Chromium always needs its base English fallback. Lattice supports simplified
// Chinese, while en_GB, zh_TW, and grammatical variants are separate locales
// that the product does not select and can safely fall back to these bases.
export const CHROMIUM_LOCALE_ALLOWLIST = new Set(["en.lproj", "zh_CN.lproj"]);
// Generic `zh` lets every Chinese system variant select the bundled simplified
// catalog, matching resolveAppLocale's existing behavior.
export const CHROMIUM_BUNDLE_LOCALIZATIONS = ["en", "zh"];

export function pruneChromiumLocales(root) {
  let removed = 0;

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const path = join(directory, entry.name);
      if (entry.name.endsWith(".lproj")) {
        if (!CHROMIUM_LOCALE_ALLOWLIST.has(entry.name)) {
          rmSync(path, { recursive: true });
          removed += 1;
        }
        continue;
      }
      visit(path);
    }
  }

  visit(root);
  const frameworkResources = join(
    root,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Resources",
  );
  for (const locale of CHROMIUM_LOCALE_ALLOWLIST) {
    const pack = join(frameworkResources, locale, "locale.pak");
    if (!existsSync(pack)) {
      throw new Error(`Electron Framework is missing required locale pack ${locale}/locale.pak`);
    }
  }
  return removed;
}
