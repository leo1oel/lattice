import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Csp = Record<string, string[]>;

type TauriConfig = {
  app: {
    security: {
      csp: Csp | null;
      devCsp?: Csp | null;
      dangerousDisableAssetCspModification?: string[] | boolean;
    };
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
const rustApp = readFileSync("src-tauri/src/lib.rs", "utf8");

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
    // scripts at a sandboxed null origin, so unsafe-inline is required; eval is
    // not. The assertion above prevents Tauri's generated hashes from silently
    // overriding that compatibility source in production packages.
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
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
    expect(rustApp).toContain('.with_filter(|label| !label.starts_with("browser-"))');
  });
});
