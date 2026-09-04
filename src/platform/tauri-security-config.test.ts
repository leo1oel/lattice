import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Csp = Record<string, string[]>;

type TauriConfig = {
  build: {
    beforeBuildCommand: string;
  };
  app: {
    windows: Array<{ visible?: boolean }>;
    security: {
      csp: Csp | null;
      devCsp?: Csp | null;
      dangerousDisableAssetCspModification?: string[] | boolean;
    };
  };
  bundle: {
    resources: string[];
  };
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
const browserHost = readFileSync("src-tauri/src/browser_host.rs", "utf8");
const chromiumRuntime = readFileSync("src-tauri/src/chromium.rs", "utf8");
const chromiumShell = readFileSync("scripts/chromium-shell.mjs", "utf8");
const chromiumPrepare = readFileSync("scripts/prepare-chromium-runtime.mjs", "utf8");
const buildPrepare = readFileSync("scripts/prepare-build.mjs", "utf8");
const synaraNodeStaging = readFileSync("scripts/synara-node-runtime.mjs", "utf8");
const synaraRuntime = readFileSync("src-tauri/src/synara.rs", "utf8");
const presentationRuntime = readFileSync("src-tauri/src/presentation.rs", "utf8");
const indexHtml = readFileSync("index.html", "utf8");

describe("Tauri security boundary", () => {
  it("keeps an explicit production and development CSP", () => {
    const production = config.app.security.csp;
    const development = config.app.security.devCsp;

    expect(production).not.toBeNull();
    expect(development).not.toBeNull();
    // Keep dev explicit rather than falling back implicitly. Vite uses the same
    // resource classes as production and does not require unsafe-eval.
    expect(development).toEqual(production);
    expect(production?.["default-src"]).toEqual(["'none'"]);
    expect(production?.["object-src"]).toEqual(["'none'"]);
    expect(production?.["base-uri"]).toEqual(["'none'"]);
    expect(production?.["form-action"]).toEqual(["'none'"]);
    expect(production?.["frame-ancestors"]).toEqual(["'none'"]);
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

    // Tauri IPC needs both protocol spellings. HTTP(S)/WS(S) are constrained
    // to connect-src because collaboration supports a build-selected Worker or
    // local/LAN Wrangler host, while PDF.js fetches authored remote PDF URLs.
    expect(csp["connect-src"]).toEqual([
      "'self'", "ipc:", "http://ipc.localhost", "http:", "https:", "ws:", "wss:", "blob:",
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
      "core:window:allow-close",
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
    expect(capability.permissions).not.toContain("opener:default");
    expect(capability.permissions).not.toContain("opener:allow-open-path");
    expect(capability.permissions).not.toContain("dialog:default");
    expect(capability.permissions).not.toContain("updater:default");
  });

  it("keeps browser bridge windows hidden during the handoff", () => {
    // The window-state plugin shows new dynamic windows unless they are
    // filtered out, overriding the bridge builder's `visible(false)` setting.
    expect(rustApp).toContain('!label.starts_with("browser-")');
    expect(rustApp).toContain("label != browser_host::SERVICE_WINDOW_LABEL");
    expect(browserHost).toContain("tauri::ActivationPolicy::Accessory");
    expect(browserHost).toContain('.title("")');
  });

  it("keeps the fixed browser entry local, authenticated, and windowless at login", () => {
    expect(config.app.windows[0]?.visible).toBe(false);
    expect(rustApp).toContain('.arg(BROWSER_HOST_ARG)');
    expect(rustApp).toContain("browser_host_launch()");
    expect(browserHost).toContain("tauri::window::WindowBuilder::new(app, SERVICE_WINDOW_LABEL)");
    expect(browserHost).toContain("Ipv4Addr::LOCALHOST, PREFERRED_PORT");
    expect(browserHost).not.toContain("Ipv4Addr::LOCALHOST, 0");
    expect(browserHost).toContain("valid_loopback_host(&headers, state.port)");
    expect(browserHost).toContain("Some(session.browser_origin.as_str())");
    expect(browserHost).toContain('header::CACHE_CONTROL, HeaderValue::from_static("no-store")');
  });

  it("packages the sandboxed Chromium renderer without exposing workspace tokens in argv", () => {
    expect(packageJson.scripts["prepare:chromium"]).toBe(
      "node scripts/prepare-chromium-runtime.mjs --synara-node-runtime=electron",
    );
    expect(packageJson.scripts["prepare:chromium:debug"]).toBe(
      "node scripts/prepare-chromium-runtime.mjs --synara-node-runtime=standalone",
    );
    expect(config.build.beforeBuildCommand).toBe("pnpm prepare:build");
    expect(buildPrepare).toContain("process.env.TAURI_ENV_DEBUG");
    expect(buildPrepare).toContain('debug ? "prepare:runtime:dev" : "prepare:runtime"');
    expect(buildPrepare).toContain('debug ? "prepare:chromium:debug" : "prepare:chromium"');
    expect(config.bundle.resources).toContain("chromium-runtime/");
    expect(rustApp).toContain("chromium_packaged");
    expect(browserHost).toContain(".open_url(url)?");
    expect(chromiumRuntime).toContain(".stdin(Stdio::piped())");
    expect(chromiumRuntime).toContain("self.send(&ShellMessage::OpenUrl { url })");
    expect(chromiumRuntime).toContain("let message = encode_message(message)?");
    expect(chromiumRuntime).not.toContain(".arg(url)");
    expect(chromiumShell).toContain("sandbox: true");
    expect(chromiumShell).toContain("contextIsolation: true");
    expect(chromiumShell).toContain("nodeIntegration: false");
    expect(chromiumShell).toContain('from "./chromium-window-policy.mjs"');
    expect(chromiumShell).toContain("if (presenterOptions) return presenterOptions");
    expect(chromiumPrepare).toContain(
      'join(appSource, "chromium-window-policy.mjs")',
    );
    // The packaged renderer already embeds a complete Node runtime. Synara and
    // Open Slide share it in release builds, while debug builds retain the
    // independently staged Node binary instead of selecting Electron.
    expect(chromiumPrepare).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(synaraNodeStaging).toContain('nodeRuntime !== "electron"');
    expect(synaraNodeStaging).toContain('rmSync(join(synaraRoot, "bin", "node")');
    expect(synaraNodeStaging).toContain('rmSync(join(synaraRoot, "bin", "node.exe")');
    for (const runtime of [synaraRuntime, presentationRuntime]) {
      expect(runtime).toContain("tauri::is_dev()");
      expect(runtime).toContain('not(debug_assertions)');
      expect(runtime).toContain('.env("ELECTRON_RUN_AS_NODE", "1")');
      expect(runtime).toContain(
        'chromium-runtime/Lattice Chromium.app/Contents/MacOS/Electron',
      );
    }
  });

  it("keeps Chromium titlebar whitespace draggable without consuming tab interactions", () => {
    expect(chromiumShell).toContain(`
      .titlebar-main > .editor-tabs .editor-tabs-content {
        -webkit-app-region: drag;
      }
      .titlebar-main > .editor-tabs .editor-tab {
        -webkit-app-region: no-drag;
      }
    `);
  });

  it("gives loopback browser tabs the product icon", () => {
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="/src-tauri/icons/app-icon.svg" />',
    );
  });
});
