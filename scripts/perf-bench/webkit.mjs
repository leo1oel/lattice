/**
 * The performance benchmark in WebKit: Playwright's WebKit build behind the
 * same small page interface as cdp.mjs's CdpPage, so the scenarios and the
 * probe run unchanged. Release builds render in the system WKWebView, and
 * WebKit pays several times Chromium's cost per element styled or laid out,
 * so a DOM-size regression shows here first.
 *
 * WebKit has no counterpart of Chromium's Performance.getMetrics, so the
 * report-only recalc and layout counts are absent; the probe's counts
 * (commits, renders, hooks, mutations) are what this engine gates, against
 * scripts/perf-bench/budgets-webkit.json.
 *
 * Needs the browser once: `pnpm exec playwright-core install webkit`.
 */
import { webkit } from "playwright-core";

/** Playwright's names for the keys the scenarios send by their DOM `key`. */
const KEY_NAMES = { " ": "Space" };

export async function launchWebKit({ headless = true, width = 1440, height = 900 } = {}) {
  const browser = await webkit.launch({ headless });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  return {
    open: () => WebKitPage.open(context),
    close: () => browser.close(),
  };
}

/** One page with the subset of CdpPage's interface the benchmark uses. */
class WebKitPage {
  static async open(context) {
    return new WebKitPage(await context.newPage());
  }

  constructor(page) {
    this.page = page;
    this.console = [];
    page.on("console", (message) => this.console.push(`[${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => this.console.push(`[exception] ${error.message}`));
  }

  /** The CDP methods the benchmark sends, done the Playwright way. */
  async send(method, params = {}) {
    const { mouse, keyboard } = this.page;
    switch (method) {
      case "Page.addScriptToEvaluateOnNewDocument":
        await this.page.addInitScript({ content: params.source });
        return {};
      case "Page.captureScreenshot":
        return { data: (await this.page.screenshot()).toString("base64") };
      case "Input.dispatchMouseEvent":
        if (params.type === "mouseMoved") await mouse.move(params.x, params.y);
        else if (params.type === "mousePressed") {
          await mouse.move(params.x, params.y);
          await mouse.down({ button: "left", clickCount: params.clickCount ?? 1 });
        } else if (params.type === "mouseReleased") await mouse.up({ button: "left", clickCount: params.clickCount ?? 1 });
        else if (params.type === "mouseWheel") {
          await mouse.move(params.x, params.y);
          await mouse.wheel(params.deltaX ?? 0, params.deltaY ?? 0);
        } else throw new Error(`Unsupported mouse event ${params.type}`);
        return {};
      case "Input.dispatchKeyEvent": {
        const key = KEY_NAMES[params.key] ?? params.key;
        if (params.type === "keyUp") await keyboard.up(key);
        else await keyboard.down(key);
        return {};
      }
      default:
        throw new Error(`${method} has no WebKit counterpart in the benchmark (CPU profiles are Chromium-only)`);
    }
  }

  async evaluate(expression) {
    return this.page.evaluate(expression);
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: "load" });
  }

  async resize(width, height) {
    await this.page.setViewportSize({ width, height });
  }

  /** WebKit exposes no style or layout counters. */
  async metrics() {
    return {};
  }

  async close() {
    await this.page.close();
  }
}
