/**
 * A dependency-free Chrome DevTools Protocol client for the performance
 * benchmark: launches a headless Chrome and drives one page over the browser
 * WebSocket with flattened sessions. Node's global WebSocket (Node 22+) is the
 * only transport, so CI needs no Playwright or Puppeteer download.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onShutdown, once } from "./shutdown.mjs";

/** The first Chrome/Chromium the machine has, unless `CHROME_PATH` names one. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  // Playwright's Chrome for Testing, newest first, when a developer has one.
  const playwright = path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  if (existsSync(playwright)) {
    for (const entry of readdirSync(playwright).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      candidates.push(
        path.join(playwright, entry, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        path.join(playwright, entry, "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        path.join(playwright, entry, "chrome-linux64/chrome"),
        path.join(playwright, entry, "chrome-linux/chrome"),
      );
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("No Chrome found. Install Google Chrome, run `pnpm exec playwright-core install chromium`, or set CHROME_PATH.");
  return found;
}

export async function launchChrome({ executable = findChrome(), headless = true, width = 1440, height = 900 } = {}) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "lattice-perf-bench-"));
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    // Timers and frames must run at full rate even though no window is focused.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    ...(headless ? ["--headless=new"] : []),
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  // A signal awaits close() (shutdown.mjs), which also removes the profile;
  // the exit hook is the last resort for an exit that does not (a thrown
  // error, a second signal, a close that overran its grace), so the browser
  // never outlives perf-bench.
  const killOnExit = () => child.kill("SIGTERM");
  process.on("exit", killOnExit);
  let connection = null;
  const close = once(async () => {
    unregister();
    process.off("exit", killOnExit);
    connection?.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", resolve);
    });
    // Chrome's helper processes can outlive the browser process for a moment
    // and keep writing into the profile, so a single rmdir races them
    // (ENOTEMPTY). rmSync's own maxRetries only re-attempts the final rmdir
    // without deleting files written since its first pass, so retry the
    // whole removal instead.
    for (let attempt = 1; ; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== "ENOTEMPTY" || attempt === 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  });
  // Registered before DevTools answers: a signal during startup must remove
  // the profile too.
  const unregister = onShutdown(close);
  let endpoint;
  try {
    endpoint = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${output}`)), 30_000);
      child.stderr.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited (${code}) before DevTools was ready:\n${output}`));
      });
    });
    connection = await CdpConnection.connect(endpoint);
  } catch (error) {
    // A browser that never came up still made its profile.
    await close().catch(() => {});
    throw error;
  }
  return {
    connection,
    /** The browser's DevTools WebSocket, for another client (chrome-devtools-axi) to attach to. */
    endpoint,
    /** Stops the browser and removes its profile; safe to call more than once. */
    close,
  };
}

class CdpConnection {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
    return new CdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

/** One page target with its own flattened session. */
export class CdpPage {
  static async open(connection) {
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new CdpPage(connection, sessionId, targetId);
    await Promise.all([
      page.send("Page.enable"),
      page.send("Runtime.enable"),
      page.send("Performance.enable", { timeDomain: "threadTicks" }),
    ]);
    return page;
  }

  constructor(connection, sessionId, targetId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.console = [];
    connection.on((message) => {
      if (message.sessionId !== this.sessionId) return;
      if (message.method === "Runtime.consoleAPICalled") {
        const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
        this.console.push(`[${message.params.type}] ${text}`);
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        this.console.push(`[exception] ${details.exception?.description ?? details.text}`);
      }
    });
  }

  send(method, params) {
    return this.connection.send(method, params, this.sessionId);
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value;
  }

  async navigate(url) {
    const loaded = new Promise((resolve) => {
      const off = this.connection.on((message) => {
        if (message.sessionId === this.sessionId && message.method === "Page.loadEventFired") {
          off();
          resolve();
        }
      });
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /** Lays the page out at this viewport, whatever the window's size. */
  async resize(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }

  /** Chromium's own counters: RecalcStyleCount, LayoutCount and their durations. */
  async metrics() {
    const { metrics } = await this.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
  }

  async close() {
    await this.connection.send("Target.closeTarget", { targetId: this.targetId });
  }
}
