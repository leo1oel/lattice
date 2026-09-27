// In-app auto-update for Lattice, built on tauri-plugin-updater.
//
// Provides:
//   <UpdaterProvider>        wrap your app once (main.tsx)
//   <UpdateBanner corner />  the corner "new version" popup + one-click update
//   useUpdater()             read/drive the updater from anywhere
//
// Update packages are verified with the updater's own minisign key, which is
// separate from Apple code signing (releases are additionally signed and
// notarized — see docs/release-process.md). In a plain web/dev build (no Tauri
// runtime) every call no-ops, so this is safe to always mount.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { toMessage } from "../app-utils";
import { addAppLog } from "./app-log-store";

export type UpdateMode = "auto" | "manual";
type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

/**
 * Which step produced `error`. Checking and installing both land in the same
 * "error" phase, but only one of them ever downloaded anything: a check that
 * fails because the machine is offline is not a failed update, and saying so
 * tells people an install they never started went wrong.
 */
type UpdateErrorKind = "check" | "install";

const MODE_KEY = "lattice.update.mode.v1";
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

function getUpdateMode(): UpdateMode {
  try {
    return localStorage.getItem(MODE_KEY) === "auto" ? "auto" : "manual";
  } catch {
    return "manual";
  }
}

function persistUpdateMode(mode: UpdateMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage unavailable — the choice still applies for this session.
  }
}

/** Minimal shape of the object returned by `@tauri-apps/plugin-updater`'s check(). */
type TauriUpdate = {
  version: string;
  currentVersion: string;
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
};

type DownloadEvent =
  | { event: "Started"; data?: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** Lazy-load the updater plugin so a browser/dev build doesn't crash on import. */
async function loadUpdateCheck() {
  return (await import("@tauri-apps/plugin-updater")).check;
}

async function restartAfterUpdate() {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("restart_after_update");
  } catch (reason) {
    // An updater can replace the app bundle before the old process exits. If
    // that process then reloads the new frontend, releases before v0.1.251 do
    // not know this app-owned command yet. Their process plugin is available,
    // so use the older restart path only for that exact compatibility case.
    if (toMessage(reason) !== "Command restart_after_update not found") throw reason;
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }
}

type UpdaterState = {
  phase: UpdatePhase;
  version: string | null;
  progress: number; // 0..1
  error: string | null;
  errorKind: UpdateErrorKind | null;
};

export type UpdaterApi = UpdaterState & {
  mode: UpdateMode;
  setMode: (mode: UpdateMode) => void;
  /** Check now. `silent` (default) never surfaces "up to date"/errors. */
  check: (silent?: boolean) => Promise<void>;
  /** Download + install the pending update, then restart. Safe to call once. */
  install: () => Promise<void>;
  /** Hide the "available" banner without installing. */
  dismiss: () => void;
};

const IDLE: UpdaterState = { phase: "idle", version: null, progress: 0, error: null, errorKind: null };
const FAILURE_TITLES: Record<UpdateErrorKind, string> = {
  check: "Couldn’t check for Lattice updates",
  install: "Lattice update failed",
};

function useAppUpdater(intervalMs = DEFAULT_CHECK_INTERVAL_MS, autoCheck = true): UpdaterApi {
  const [mode, setModeState] = useState<UpdateMode>(getUpdateMode);
  const [state, setState] = useState<UpdaterState>(IDLE);
  const pendingRef = useRef<TauriUpdate | null>(null);
  const installingRef = useRef(false);
  /**
   * Set while `pendingRef` holds an update whose install failed. The update
   * itself is kept so "Update now" can retry it, but it must stop gating
   * `check` — see the note on `dismiss` for the same early return reached from
   * the other side.
   */
  const installFailedRef = useRef(false);
  const modeRef = useRef(mode);

  const patch = useCallback((next: Partial<UpdaterState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);
  const fail = useCallback((errorKind: UpdateErrorKind, reason: unknown) => {
    const detail = toMessage(reason);
    patch({ phase: "error", error: detail, errorKind });
    addAppLog({ level: "error", source: "App updater", title: FAILURE_TITLES[errorKind], detail, toast: false });
  }, [patch]);

  const install = useCallback(async () => {
    const update = pendingRef.current;
    if (!update || installingRef.current) return;
    installingRef.current = true;
    installFailedRef.current = false;
    patch({ phase: "downloading", progress: 0 });
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data?.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) patch({ progress: Math.min(1, received / total) });
        } else if (event.event === "Finished") {
          patch({ phase: "installing", progress: 1 });
        }
      });
      patch({ phase: "ready" });
      // The visible workspace runs in bundled Chromium and reaches Tauri
      // through a hidden bridge WebView. The process plugin only requests an
      // event-loop restart; if that request stalls, the newly installed app is
      // left on disk while the old process displays “Restarting…” forever.
      // The app-owned command closes both child runtimes and takes Tauri's
      // direct main-thread restart path instead.
      await restartAfterUpdate();
    } catch (reason) {
      installingRef.current = false;
      installFailedRef.current = true;
      fail("install", reason);
    }
  }, [fail, patch]);

  const setMode = useCallback((next: UpdateMode) => {
    setModeState(next);
    persistUpdateMode(next);
    // Switching to automatic while an update is already waiting installs it now.
    if (next === "auto" && pendingRef.current && !installingRef.current) {
      void install();
    }
  }, [install]);

  // Refreshed in a layout effect rather than during render: `check` reads it
  // from inside a callback, so it always runs after this lands, and a
  // render-phase write makes the React Compiler skip the whole provider.
  useLayoutEffect(() => {
    modeRef.current = mode;
  });

  const check = useCallback(async (silent = true) => {
    // A held update is what stops a second banner for one already offered —
    // but only while it is still installable. Once its install has failed the
    // banner is a failure banner, and holding the check hostage to it means
    // the next release is never noticed for the rest of the session.
    if (installingRef.current) return;
    if (pendingRef.current && !installFailedRef.current) return;
    try {
      const checkForUpdate = await loadUpdateCheck();
      if (!silent) patch({ phase: "checking" });
      const update = (await checkForUpdate()) as TauriUpdate | null;
      if (update?.version && update.version !== update.currentVersion) {
        pendingRef.current = update;
        installFailedRef.current = false;
        patch({ phase: "available", version: update.version, error: null, errorKind: null });
        if (modeRef.current === "auto") void install();
      } else if (!silent) {
        patch({ phase: "up-to-date" });
      }
    } catch (reason) {
      // Browser/dev (no Tauri) or a transient network error: stay quiet unless
      // the user explicitly pressed "Check for updates".
      if (!silent) fail("check", reason);
    }
  }, [fail, install, patch]);

  /**
   * Put the banner away, and let checking resume.
   *
   * `check` returns early while `pendingRef` holds an update, so a dismissed
   * update has to be released here or no later check — the six-hourly one or
   * the button in Settings — could notice a release for the rest of the
   * session. The same × also clears a failure banner.
   */
  const dismiss = useCallback(() => {
    pendingRef.current = null;
    installFailedRef.current = false;
    patch({ phase: "idle", error: null, errorKind: null });
  }, [patch]);

  useEffect(() => {
    if (!autoCheck) return;
    void check(true);
    const timer = window.setInterval(() => void check(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [autoCheck, check, intervalMs]);

  return { ...state, mode, setMode, check, install, dismiss };
}

// ---- Context so the banner and the Settings toggle share one updater ----

const UpdaterContext = createContext<UpdaterApi | null>(null);

export function UpdaterProvider(props: {
  children: ReactNode;
  intervalMs?: number;
  autoCheck?: boolean;
}) {
  const api = useAppUpdater(props.intervalMs, props.autoCheck);
  return <UpdaterContext.Provider value={api}>{props.children}</UpdaterContext.Provider>;
}

// A no-op updater for subtrees mounted without a provider (unit tests, plain
// web previews). Matches this module's "safe to always mount" contract rather
// than crashing the whole tree when the provider happens to be absent.
const DISCONNECTED_UPDATER: UpdaterApi = {
  ...IDLE,
  mode: "manual",
  setMode: () => {},
  check: async () => {},
  install: async () => {},
  dismiss: () => {},
};

export function useUpdater(): UpdaterApi {
  return useContext(UpdaterContext) ?? DISCONNECTED_UPDATER;
}

// ---- UI ----

export type BannerCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export function UpdateBanner({ corner = "top-right" }: { corner?: BannerCorner }) {
  const { phase, version, progress, error, errorKind, install, dismiss } = useUpdater();

  // A failed check has nothing to report here: it only happens when someone
  // pressed "Check for updates" in Settings, which reports the outcome in the
  // row they pressed (and it is in the app log either way). The corner banner
  // is for an update that was actually being installed, so a check that could
  // not reach the server must not raise "Update failed" over the editor.
  const failedInstall = phase === "error" && errorKind !== "check";
  // Progress phases stack the bar under the title so the title never gets
  // squeezed onto a second line / truncated beside the bar.
  const stacked = phase === "downloading" || phase === "installing";
  if (!(phase === "available" || stacked || phase === "ready" || failedInstall)) return null;

  const pct = Math.round(progress * 100);
  const dismissButton = (
    <button type="button" className="app-update-dismiss" aria-label="Dismiss" onClick={dismiss}>
      ×
    </button>
  );

  return (
    <div className={`app-update-banner smooth-shadow-ring-lg ${corner} ${phase}${stacked ? " stacked" : ""}`} role="status" aria-live="polite">
      {phase === "available" && (
        <>
          <div className="app-update-text">
            <strong>New version {version}</strong>
            <span>Ready to install</span>
          </div>
          <button type="button" className="app-update-primary" onClick={() => void install()}>
            Update now
          </button>
          {dismissButton}
        </>
      )}

      {stacked && (
        <>
          <div className="app-update-text">
            <strong className="app-update-active-title">
              <InfinityLoader size={14} />
              {phase === "installing" ? "Installing…" : "Downloading update…"}
            </strong>
            <span>{phase === "downloading" ? `${pct}%` : "Almost done"}</span>
          </div>
          <div className="app-update-progress">
            <div className="app-update-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}

      {phase === "ready" && (
        <div className="app-update-text">
          <strong className="app-update-active-title"><InfinityLoader size={14} /> Restarting…</strong>
        </div>
      )}

      {failedInstall && (
        <>
          <div className="app-update-text">
            <strong>Update failed</strong>
            <span title={error ?? undefined}>{error ?? "Please try again later"}</span>
          </div>
          {dismissButton}
        </>
      )}
    </div>
  );
}
