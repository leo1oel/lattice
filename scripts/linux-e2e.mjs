#!/usr/bin/env node
/**
 * End-to-end check of a built Linux AppImage, through tauri-driver.
 *
 * tauri-driver (https://v2.tauri.app/develop/tests/webdriver/) is a WebDriver
 * server that starts the app under WebKitGTK's own WebKitWebDriver; it exists
 * on Linux and Windows only, which is why this check runs on the AppImage
 * and has no macOS twin. The release attaches the AppImage only when this
 * passes (.github/workflows/linux-appimage.yml).
 *
 * With a fresh HOME the run checks, in order:
 *   1. the app starts, and the tutorial's main.tex opens in the editor (a
 *      first launch opens it by itself; from the welcome screen the run
 *      presses Guided tutorial, as a writer would);
 *   2. that first build succeeds and the PDF preview draws page 1;
 *   3. pressing Build builds it again, and that build succeeds too;
 *   4. the Agent panel shows the "isn't available on Linux yet" notice
 *      (the built-in Agent stays off without a .bib guard, PR #668).
 *
 * It speaks the W3C WebDriver protocol with fetch, so it needs no client
 * library. Element lookups use class names, never labels, as the bench's
 * selectors do (scripts/perf-bench/selectors.mjs). On failure it saves a
 * screenshot and the page's text to the artifacts folder.
 *
 * Usage: node scripts/linux-e2e.mjs --app PATH [--driver URL] [--artifacts DIR]
 *   --app        the AppImage (or extracted AppRun) to launch
 *   --driver     tauri-driver's URL (default http://127.0.0.1:4444)
 *   --artifacts  where a failure's screenshot and page text go (default .tmp/linux-e2e)
 * Exit codes: 0 every check passed · 1 a check failed · 2 usage error.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BUILD_BUTTON } from "./perf-bench/selectors.mjs";
import { isMain } from "./lib/util.mjs";

const EDITOR = ".cm-editor .cm-content";
const WELCOME_TUTORIAL = ".welcome-screen button.welcome-tutorial";
const PDF_PAGE = ".pdfViewer .page[data-page-number=\"1\"] canvas";
const AGENT_UNSUPPORTED = ".synara-unsupported-notice";
// A cold first build compiles the tutorial with latexmk and BibTeX: allow
// for a slow runner, but not for a hang.
const BUILD_TIMEOUT_MS = 240_000;
const W3C_ELEMENT = "element-6066-11e4-a52e-4a52e4a52e4a";

export function webDriver(base) {
  async function call(method, route, body) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.value?.error) {
      const { error = response.status, message = "" } = payload.value ?? {};
      throw new Error(`WebDriver ${method} ${route}: ${error} ${message}`.trim());
    }
    return payload.value;
  }
  return { call };
}

async function startSession(driver, app) {
  const value = await driver.call("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: app } } },
  });
  const id = value.sessionId;
  const at = (route) => `/session/${id}${route}`;
  const session = {
    id,
    run: (script, args = []) => driver.call("POST", at("/execute/sync"), { script, args }),
    // W3C names an element reference by a fixed key; take the one value
    // whatever key the driver chose, and fail loudly if there is none.
    find: async (selector) => {
      const reference = await driver.call("POST", at("/element"), { using: "css selector", value: selector });
      const id = reference?.[W3C_ELEMENT] ?? Object.values(reference ?? {})[0];
      if (typeof id !== "string") throw new Error(`WebDriver found no element reference for ${selector}: ${JSON.stringify(reference)}`);
      return id;
    },
    click: (element) => driver.call("POST", at(`/element/${element}/click`), {}),
    keys: (actions) => driver.call("POST", at("/actions"), { actions: [{ type: "key", id: "keyboard", actions }] }),
    screenshot: () => driver.call("GET", at("/screenshot")),
    end: () => driver.call("DELETE", at("")),
  };
  return session;
}

/** Poll `script` (a function body returning a truthy value when done) until it is, or fail. */
async function waitFor(session, what, script, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await session.run(script);
      if (value) return value;
    } catch (error) {
      // A navigation or a reload between polls; the next poll sees the page.
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs / 1000} s waiting for ${what}${last ? ` (last error: ${last.message})` : ""}`);
}

const present = (selector) => `return Boolean(document.querySelector(${JSON.stringify(selector)}));`;

/** Whether `selector` stays on the page for all of `ms`; false as soon as it goes. */
async function stillPresent(session, selector, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // A failed poll is a navigation in progress, which is not the element going.
    if (!(await session.run(present(selector)).catch(() => true))) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
}
const buildState = `
  const button = document.querySelector(${JSON.stringify(BUILD_BUTTON)});
  if (!button) return null;
  for (const state of ["building", "succeeded", "failed"]) if (button.classList.contains("is-" + state)) return state;
  return "idle";
`;

async function waitForBuild(session, label) {
  const outcome = await waitFor(
    session,
    `${label} to finish`,
    `const state = (() => { ${buildState} })(); return state === "succeeded" || state === "failed" ? state : null;`,
    BUILD_TIMEOUT_MS,
  );
  if (outcome !== "succeeded") throw new Error(`${label} failed`);
}

export async function runChecks(session, log = console.log) {
  const editorReady = `Boolean(document.querySelector(${JSON.stringify(EDITOR)}) && document.querySelector(${JSON.stringify(BUILD_BUTTON)}))`;
  const first = await waitFor(
    session,
    "the editor or the welcome screen",
    `return ${editorReady} ? "editor" : document.querySelector(${JSON.stringify(WELCOME_TUTORIAL)}) ? "welcome" : null;`,
    60_000,
  );
  // A first launch opens the tutorial by itself, but the welcome screen can show
  // for a moment before it does: run 42393985323 (v0.15.8) saw the button, then
  // pressed it after it had gone. Press Guided tutorial only when the welcome
  // screen is still up a few seconds later.
  if (first === "welcome" && (await stillPresent(session, WELCOME_TUTORIAL, 5_000))) {
    // A first launch should have opened the tutorial; say what the screen said instead.
    const text = String(await session.run("return document.body.innerText;")).replace(/\s+/g, " ").slice(0, 600);
    log(`note: the app started on the welcome screen (${text}); pressing Guided tutorial`);
    await session.click(await session.find(WELCOME_TUTORIAL));
  }
  await waitFor(session, "the tutorial open in the editor", `return ${editorReady};`, 120_000);
  log("ok: the app started and opened the tutorial");

  await waitForBuild(session, "the tutorial's first build");
  await waitFor(session, "the PDF preview's first page", present(PDF_PAGE), 60_000);
  log("ok: the first build succeeded and the PDF preview drew page 1");

  await session.click(await session.find(BUILD_BUTTON));
  await waitFor(session, "Build to start a build", `return (() => { ${buildState} })() === "building";`, 15_000);
  await waitForBuild(session, "the second build");
  await waitFor(session, "the PDF preview after the second build", present(PDF_PAGE), 60_000);
  log("ok: Build rebuilt the tutorial");

  // ⌃⌥3 toggles the Agent panel off macOS (src/app/panel-toggles.ts); it may
  // already be open in the tutorial's layout, and a press would then close it.
  if (!(await session.run(present(AGENT_UNSUPPORTED)))) {
    const chord = ["\uE009", "\uE00A", "3"]; // Control, Alt, 3 (WebDriver key codes)
    await session.keys([...chord.map((value) => ({ type: "keyDown", value })), ...chord.reverse().map((value) => ({ type: "keyUp", value }))]);
  }
  const notice = await waitFor(session, "the Agent's Linux notice", `const node = document.querySelector(${JSON.stringify(AGENT_UNSUPPORTED)}); return node ? node.textContent : null;`, 30_000);
  if (!/Linux/.test(notice)) throw new Error(`The Agent panel's notice does not mention Linux: ${notice}`);
  log("ok: the Agent panel says the Agent is not available on Linux yet");
}

async function saveEvidence(session, directory) {
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(path.join(directory, "failure.png"), Buffer.from(await session.screenshot(), "base64"));
  } catch (error) {
    console.error(`could not take a screenshot: ${error.message}`);
  }
  try {
    writeFileSync(path.join(directory, "failure.txt"), String(await session.run("return document.body.innerText;")));
  } catch (error) {
    console.error(`could not read the page text: ${error.message}`);
  }
  console.error(`evidence saved to ${directory}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      driver: { type: "string", default: "http://127.0.0.1:4444" },
      artifacts: { type: "string", default: ".tmp/linux-e2e" },
    },
  });
  if (!values.app) {
    console.error("Usage: node scripts/linux-e2e.mjs --app PATH [--driver URL] [--artifacts DIR]");
    return 2;
  }
  const session = await startSession(webDriver(values.driver), path.resolve(values.app));
  try {
    await runChecks(session);
    console.log("linux e2e: every check passed");
    return 0;
  } catch (error) {
    console.error(`linux e2e failed: ${error.message}`);
    await saveEvidence(session, path.resolve(values.artifacts));
    return 1;
  } finally {
    await session.end().catch(() => {});
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`linux e2e failed: ${error.message}`);
    process.exitCode = 1;
  });
}
