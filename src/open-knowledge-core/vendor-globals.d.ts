// Support shim for vendored Open Knowledge core and app code.
//
// `src/` in this repo is browser-only by convention and deliberately carries
// no `@types/node`. Vendored files reference `process.env.NODE_ENV` (Vite
// statically replaces it in builds; Node provides it under vitest), so the
// declaration is non-optional to match upstream's unguarded usage while
// still not pulling in the full Node global surface.
declare var process: { env: Record<string, string | undefined> };

// Minimal shape of upstream's Electron preload bridge (`window.okDesktop`,
// declared upstream in packages/app/src/lib/desktop-bridge-types.ts). The
// bridge is always undefined in Research Writer — vendored code guards every
// access — but the property must exist on Window for typechecking.
interface OkDesktopShellBridge {
  openExternal(url: string): Promise<void>;
  openAsset(projectRelPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  revealAsset(projectRelPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

interface Window {
  okDesktop?: { shell: OkDesktopShellBridge };
}
