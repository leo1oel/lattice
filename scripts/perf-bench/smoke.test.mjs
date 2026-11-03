// @vitest-environment node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PERF_BENCH = fileURLToPath(new URL("../perf-bench.mjs", import.meta.url));

/**
 * The real `pnpm perf:bench` end to end: a production build served with
 * --serve --smoke --chrome, smoke checks of that page in each interface
 * language, a paste into Add papers on its Chrome, and the SIGTERM that
 * docs/driving-the-app.md stops it with. TMPDIR
 * is a directory of the test's own, so what the run leaves behind there is
 * this run's alone. A production build and three Chrome sessions are too slow
 * for the default suite, so it runs only with LATTICE_E2E=1
 * (`pnpm test:e2e-harness`, which .github/workflows/bench-harness.yml runs).
 * LATTICE_E2E_TMPDIR puts that directory under a parent the caller owns and
 * keeps it afterwards, so CI can upload a failed smoke check's screenshot.
 */
describe.skipIf(process.env.LATTICE_E2E !== "1")("perf-bench --serve --smoke --chrome", () => {
  let tmp;
  let server;
  let exited;
  let output = "";
  const env = () => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !["NODE_ENV", "VITEST", "TEST"].includes(name))),
    TMPDIR: tmp,
  });
  const leftovers = () => readdirSync(tmp).filter((name) => name.startsWith("lattice-perf-bench-"));

  function perfBench(args) {
    const child = spawn(process.execPath, [PERF_BENCH, ...args], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });
  }

  beforeAll(async () => {
    const parent = process.env.LATTICE_E2E_TMPDIR;
    if (parent) mkdirSync(parent, { recursive: true });
    tmp = mkdtempSync(path.join(parent ?? os.tmpdir(), "lattice-smoke-test-"));
    server = spawn(process.execPath, [PERF_BENCH, "--serve", "--smoke", "--chrome", "--port", "0", "--lang", "zh-CN"], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    server.stderr.on("data", (chunk) => (stderr += chunk));
    exited = new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      server.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("Press Ctrl-C to stop.")) resolve();
      });
      exited.then(({ code }) => reject(new Error(`perf-bench exited ${code} before serving:\n${output}\n${stderr}`)));
    });
  }, 240_000);

  afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
    if (tmp && !process.env.LATTICE_E2E_TMPDIR) rmSync(tmp, { recursive: true, force: true });
  });

  function pageUrl(lang) {
    const url = new URL(output.match(/^ {2}(http:\/\/\S+)$/m)[1]);
    url.searchParams.set("lang", lang);
    return url.href;
  }

  it("passes the smoke check of a page served in Chinese", () => {
    expect(output).toMatch(/Smoke check passed: .*\(interface language: zh-CN\)/);
    expect(leftovers()).toEqual(expect.arrayContaining([expect.stringMatching(/^lattice-perf-bench-dist-/), expect.stringMatching(/^lattice-perf-bench-(?!dist-)/)]));
  });

  it("passes the smoke check in English", async () => {
    const result = await perfBench(["--smoke", "--url", pageUrl("en")]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Smoke check passed: .*\(interface language: en\)/);
  }, 180_000);

  it("passes the smoke check when lang=system resolves to Chinese", async () => {
    const result = await perfBench(["--smoke", "--url", pageUrl("system"), "--locale", "zh-CN"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Smoke check passed: .*\(interface language: zh-CN\)/);
  }, 180_000);

  it("shows a card, not the crash page, for an arXiv link pasted into Add papers", async () => {
    // Regression: the bench answered `resolve_citation_query` with null, and
    // the sheet's rows read it while rendering, so every pasted identifier
    // replaced the window with "Lattice couldn’t open this window".
    const browser = await chromium.connectOverCDP(output.match(/CHROME_DEVTOOLS_AXI_BROWSER_URL=(\S+)/)[1]);
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(pageUrl("en"));
      await page.getByRole("button", { name: "Add papers…" }).click({ timeout: 90_000 });
      await page.getByRole("textbox", { name: "Paste references" }).fill("https://arxiv.org/abs/2312.00752");
      const card = page.getByRole("dialog", { name: "Add papers" })
        .locator("li", { hasText: "Mamba: Linear-Time Sequence Modeling with Selective State Spaces" });
      await card.locator('.add-papers-state[data-tone="new"]').waitFor({ timeout: 30_000 });
      expect(await page.evaluate(() => [...globalThis.__latticeBench.unhandled])).not.toContain("resolve_citation_query");
      expect(await page.getByText("Lattice couldn’t open this window").count()).toBe(0);
    } finally {
      // A CDP connection only disconnects; the server's Chrome stays for the SIGTERM check.
      await browser.close();
    }
  }, 180_000);

  it("leaves neither the build nor the browser profile behind after SIGTERM", async () => {
    server.kill("SIGTERM");
    expect(await exited).toEqual({ code: 143, signal: null });
    expect(leftovers()).toEqual([]);
  }, 30_000);
});
