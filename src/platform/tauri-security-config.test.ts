import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Csp = Record<string, string[]>;

type TauriConfig = {
  build: { beforeBuildCommand: string };
  app: {
    windows: Array<{ visible?: boolean }>;
    security: {
      csp: Csp | null;
      devCsp?: Csp | null;
      dangerousDisableAssetCspModification?: string[] | boolean;
    };
  };
  bundle: { resources: string[] };
};

type Capability = {
  windows: string[];
  permissions: string[];
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const config = readJson<TauriConfig>("src-tauri/tauri.conf.json");
const capability = readJson<Capability>("src-tauri/capabilities/default.json");
const packageJson = readJson<{ scripts: Record<string, string> }>("package.json");
const rustApp = readFileSync("src-tauri/src/lib.rs", "utf8");
// The browser host module: its listener and windows, plus the HTTP server and
// dialog commands split out beside it.
const browserHost = ["browser_host.rs", "browser_host/server.rs", "browser_host/dialogs.rs"]
  .map((file) => readFileSync(`src-tauri/src/${file}`, "utf8"))
  .join("\n");
const chromiumRuntime = readFileSync("src-tauri/src/chromium.rs", "utf8");
const chromiumShell = readFileSync("scripts/chromium-shell.mjs", "utf8");
const chromiumPrepare = readFileSync("scripts/prepare-chromium-runtime.mjs", "utf8");
const buildPrepare = readFileSync("scripts/prepare-build.mjs", "utf8");
const synaraNodeStaging = readFileSync("scripts/synara-node-runtime.mjs", "utf8");
const synaraRuntime = readFileSync("src-tauri/src/synara.rs", "utf8");
const presentationRuntime = readFileSync("src-tauri/src/presentation.rs", "utf8");
const indexHtml = readFileSync("index.html", "utf8");

function expectContains(source: string, ...needles: string[]): void {
  for (const needle of needles) expect(source).toContain(needle);
}

describe("Tauri security boundary", () => {
  it("keeps an explicit production and development CSP", () => {
    const production = config.app.security.csp;
    const development = config.app.security.devCsp;

    expect(production).not.toBeNull();
    expect(development).not.toBeNull();
    // Keep dev explicit rather than falling back implicitly. Vite uses the same
    // resource classes as production and does not require unsafe-eval.
    expect(development).toEqual(production);
    for (const directive of ["default-src", "object-src", "base-uri", "form-action", "frame-ancestors"]) {
      expect(production?.[directive]).toEqual(["'none'"]);
    }
    expect(JSON.stringify(production)).not.toContain('"*"');
    expect(JSON.stringify(production)).not.toContain("'unsafe-eval'");
    // Tauri normally appends script hashes. CSP3 then ignores unsafe-inline,
    // which breaks authored scripts in sandboxed about:srcdoc HTML previews
    // because they inherit the host policy. Disable modification for this one
    // directive only; Tauri keeps processing styles and every other directive.
    expect(config.app.security.dangerousDisableAssetCspModification).toEqual(["script-src"]);
  });

  it("retains only the resource sources required by WebView features", () => {
    const csp = config.app.security.csp!;

    // Tauri IPC needs both protocol spellings. HTTP(S) and WS are constrained
    // to connect-src: PDF.js fetches authored remote PDF URLs, and the browser
    // host bridge talks to its loopback WebSocket.
    expect(csp["connect-src"]).toEqual([
      "'self'", "ipc:", "http://ipc.localhost", "http:", "https:", "ws:", "blob:",
    ]);
    // Synara selects an authenticated 127.0.0.1 port at runtime. The same
    // directive also preserves authored HTTP(S) Embed blocks; the Synara and
    // HTML-preview iframe sandboxes and message origin/source checks stay the
    // inner trust boundary.
    expect(csp["frame-src"]).toEqual(["'self'", "http:", "https:"]);
    // PDF.js and generated previews use bundled/blob workers and data/blob
    // images. Authored visual documents may contain remote image/media URLs.
    expect(csp["worker-src"]).toEqual(["'self'", "blob:"]);
    expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:", "http:", "https:"]);
    expect(csp["media-src"]).toEqual(["'self'", "data:", "blob:", "http:", "https:"]);
    expect(csp["font-src"]).toEqual(["'self'", "data:"]);
    // React/Tiptap write inline styles. Authored HTML preview srcdoc frames run
    // scripts at a sandboxed null origin, so unsafe-inline is required; HTTPS
    // lets those previews load libraries such as Plotly without giving their
    // scripts a same-origin path back into Lattice. Eval remains disallowed.
    // The assertion above prevents Tauri's generated hashes from silently
    // overriding that compatibility source in production packages.
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp["script-src"]).toEqual(["'self'", "'unsafe-inline'", "https:"]);
  });

  it("keeps project-window permissions tied to observed API callers", () => {
    // Browser-host windows are hidden native WebViews that execute the same
    // authorized API calls on behalf of a token-authenticated loopback tab.
    expect(capability.windows).toEqual(["main", "project-*", "browser-*"]);
    expect(capability.permissions).toEqual([
      "core:default",
      "core:window:allow-set-focus",
      "core:window:allow-destroy",
      "core:window:allow-start-dragging",
      "core:window:allow-set-fullscreen",
      "core:window:allow-set-min-size",
      "core:webview:allow-set-webview-zoom",
      "clipboard-manager:allow-write-text",
      "clipboard-manager:allow-read-text",
      "clipboard-manager:allow-read-image",
      "opener:allow-open-url",
      "opener:allow-default-urls",
      "opener:allow-reveal-item-in-dir",
      "dialog:allow-message",
      "dialog:allow-open",
      "dialog:allow-save",
      "updater:allow-check",
      "updater:allow-download-and-install",
      "process:allow-restart",
      "log:default",
    ]);
    for (const broad of ["opener:default", "opener:allow-open-path", "dialog:default", "updater:default"]) {
      expect(capability.permissions).not.toContain(broad);
    }
  });

  it("keeps the fixed browser entry local and authenticated, and bridge windows hidden", () => {
    // The window-state plugin shows new dynamic windows unless they are
    // filtered out, overriding the bridge builder's `visible(false)` setting.
    expectContains(rustApp, '!label.starts_with("browser-")', "label != browser_host::SERVICE_WINDOW_LABEL");
    expectContains(browserHost, '.title("")');
    expect(config.app.windows[0]?.visible).toBe(false);
    expectContains(rustApp, ".arg(BROWSER_HOST_ARG)", "browser_host_launch()");
    expectContains(browserHost, "tauri::window::WindowBuilder::new(app, SERVICE_WINDOW_LABEL)",
      "Ipv4Addr::LOCALHOST, PREFERRED_PORT", "valid_loopback_host(&headers, state.port)",
      "Some(session.browser_origin.as_str())", 'header::CACHE_CONTROL, HeaderValue::from_static("no-store")');
    expect(browserHost).not.toContain("Ipv4Addr::LOCALHOST, 0");
  });

  it("packages the sandboxed Chromium renderer without exposing workspace tokens in argv", () => {
    expect(packageJson.scripts["prepare:chromium"]).toBe(
      "node scripts/prepare-chromium-runtime.mjs --synara-node-runtime=electron",
    );
    expect(packageJson.scripts["prepare:chromium:debug"]).toBe(
      "node scripts/prepare-chromium-runtime.mjs --synara-node-runtime=standalone",
    );
    expect(config.build.beforeBuildCommand).toBe("pnpm prepare:build");
    expectContains(buildPrepare, "process.env.TAURI_ENV_DEBUG", 'debug ? "prepare:runtime:dev" : "prepare:runtime"',
      'debug ? "prepare:chromium:debug" : "prepare:chromium"');
    expect(config.bundle.resources).toContain("chromium-runtime/");
    expect(rustApp).toContain("chromium_packaged");
    expect(browserHost).toContain(".open_url(url)?");
    expectContains(chromiumRuntime, ".stdin(Stdio::piped())", "self.send(&ShellMessage::OpenUrl { url })",
      "let message = encode_message(message)?");
    expect(chromiumRuntime).not.toContain(".arg(url)");
    expectContains(chromiumShell, "sandbox: true", "contextIsolation: true", "nodeIntegration: false",
      'from "./chromium-window-policy.mjs"', "if (presenterOptions) return presenterOptions");
    // The packaged renderer already embeds a complete Node runtime. Synara and
    // Open Slide share it in release builds, while debug builds retain the
    // independently staged Node binary instead of selecting Electron.
    expectContains(chromiumPrepare, 'join(appSource, "chromium-window-policy.mjs")', 'ELECTRON_RUN_AS_NODE: "1"');
    expectContains(synaraNodeStaging, 'nodeRuntime !== "electron"', 'rmSync(join(synaraRoot, "bin", "node")',
      'rmSync(join(synaraRoot, "bin", "node.exe")');
    for (const runtime of [synaraRuntime, presentationRuntime]) {
      expectContains(runtime, "tauri::is_dev()", "NodeRuntime::resolve(");
    }
    // Both sidecars resolve their Node through chromium.rs's NodeRuntime.
    expectContains(chromiumRuntime, "not(debug_assertions)", '.env("ELECTRON_RUN_AS_NODE", "1")',
      "chromium-runtime/Lattice Chromium.app/Contents/MacOS/Electron");
  });

  it("gives loopback browser tabs the product icon", () => {
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="/src-tauri/icons/app-icon.svg" />',
    );
  });
});
