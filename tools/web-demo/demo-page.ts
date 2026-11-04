/**
 * The website's demo: the real app in a browser tab, over an in-memory
 * backend holding the tutorial (demo-backend.ts), built by
 * scripts/web-demo.mjs into a static folder the site serves at /demo/.
 *
 * Each visit starts fresh: the tutorial as shipped (with a typo staged for
 * the Build to explain), the default layout, five notes for Revise with
 * agent. `?lang=en|zh-CN` and `?theme=light|dark` let the website open it in
 * its own language and appearance; otherwise it follows the browser's.
 * Below 900 pixels wide the workspace does not fit, so the page says so
 * instead of loading the app.
 */
import { showDemoBar, showNarrowScreenPage } from "./demo-chrome";
// app-settings has no side effects (its imports are type-only), so importing
// its keys here runs no app code before the backend is installed.
import {
  APPEARANCE_KEY, BUILD_PREFERENCES_KEY, THEME_PREFERENCE_KEY, TUTORIAL_SEEN_KEY,
} from "../../src/settings/app-settings";

const params = new URLSearchParams(location.search);
const askedLang = params.get("lang");
const lang = askedLang === "en" || askedLang === "zh-CN" ? askedLang
  : navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
const askedTheme = params.get("theme");
const theme = askedTheme === "light" || askedTheme === "dark" ? askedTheme : "system";

/**
 * Lattice's own settings, and only those: the demo shares its origin with the
 * website (and every other page on it), whose storage is not the demo's.
 */
function clearLatticeStorage() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("lattice")) localStorage.removeItem(key);
  } catch {
    // Storage switched off: the app keeps its settings in memory instead.
  }
}

function startFresh() {
  clearLatticeStorage();
  try {
    // A returning writer's setup: no first-run tour, and builds on the Build button.
    localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
    localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify({ autoBuildMode: "manual" }));
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ interfaceLanguage: lang }));
    // Stored raw, not as JSON (loadThemePreference).
    localStorage.setItem(THEME_PREFERENCE_KEY, theme);
  } catch {
    // As above.
  }
}

if (matchMedia("(max-width: 899px)").matches) {
  showNarrowScreenPage(lang, theme);
} else {
  const [{ demoTutorialFiles }, { installDemoBackend }] = await Promise.all([import("./demo-project"), import("./demo-backend")]);
  const { unhandled } = installDemoBackend(await demoTutorialFiles());
  startFresh();
  showDemoBar(lang, () => {
    // Everything the visitor did lives in this page; a reload is the clean slate.
    clearLatticeStorage();
    location.reload();
  });
  // For QA and the smoke check: the commands the demo does not answer.
  Object.assign(window, { __latticeDemo: { unhandled } });
  await import("../../src/main.tsx");
}
