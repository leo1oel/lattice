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
  body?: string | null;
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
};

type DownloadEvent =
  | { event: "Started"; data?: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** Lazy-load the updater plugin so a browser/dev build doesn't crash on import. */
async function loadUpdaterApis() {
  const updater = await import("@tauri-apps/plugin-updater");
  return { check: updater.check };
}

async function restartAfterUpdate() {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_after_update");
}

/**
 * Which step produced `error`. Checking and installing both land in the same
 * "error" phase, but only one of them ever downloaded anything: a check that
 * fails because the machine is offline is not a failed update, and saying so
 * tells people an install they never started went wrong.
 */
export type UpdateErrorKind = "check" | "install";

export type UpdaterApi = {
  mode: UpdateMode;
  setMode: (mode: UpdateMode) => void;
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  progress: number; // 0..1
  error: string | null;
  errorKind: UpdateErrorKind | null;
  /** Check now. `silent` (default) never surfaces "up to date"/errors. */
  check: (silent?: boolean) => Promise<void>;
  /** Download + install the pending update, then restart. Safe to call once. */
  install: () => Promise<void>;
  /** Hide the "available" banner without installing. */
  dismiss: () => void;
};

function useAppUpdater(options?: {
  intervalMs?: number;
  autoCheck?: boolean;
}): UpdaterApi {
  const intervalMs = options?.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const autoCheck = options?.autoCheck ?? true;

  const [mode, setModeState] = useState<UpdateMode>(getUpdateMode);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<UpdateErrorKind | null>(null);

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

  const install = useCallback(async () => {
    const update = pendingRef.current;
    if (!update || installingRef.current) return;
    installingRef.current = true;
    installFailedRef.current = false;
    try {
      setPhase("downloading");
      setProgress(0);
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data?.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) setProgress(Math.min(1, received / total));
        } else if (event.event === "Finished") {
          setProgress(1);
          setPhase("installing");
        }
      });
      setPhase("ready");
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
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(detail);
      setErrorKind("install");
      setPhase("error");
      addAppLog({ level: "error", source: "App updater", title: "Lattice update failed", detail, toast: false });
    }
  }, []);

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
      const { check: checkForUpdate } = await loadUpdaterApis();
      if (!silent) setPhase("checking");
      const update = (await checkForUpdate()) as TauriUpdate | null;
      if (update && update.version && update.version !== update.currentVersion) {
        pendingRef.current = update;
        installFailedRef.current = false;
        setVersion(update.version);
        setNotes(update.body ?? null);
        setError(null);
        setErrorKind(null);
        setPhase("available");
        if (modeRef.current === "auto") void install();
      } else if (!silent) {
        setPhase("up-to-date");
      }
    } catch (reason) {
      // Browser/dev (no Tauri) or a transient network error: stay quiet unless
      // the user explicitly pressed "Check for updates".
      if (!silent) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        setError(detail);
        setErrorKind("check");
        setPhase("error");
        addAppLog({ level: "error", source: "App updater", title: "Couldn’t check for Lattice updates", detail, toast: false });
      }
    }
  }, [install]);

  /**
   * Put the banner away, and let checking resume.
   *
   * `check` returns early while `pendingRef` holds an update, which is what
   * stops a second banner appearing for one already offered. Dismissing left
   * that ref set, so every later check — the six-hourly one and the button in
   * Settings alike — returned before doing anything: the app said "you'll be
   * notified when a new version is ready" and could no longer notice one. An
   * update dismissed by accident could not be got back for the rest of the
   * session.
   *
   * The failure banner had the same shape from the other side: its × mapped
   * only "available" to "idle", so on an error it did nothing at all and the
   * banner stayed in the corner until relaunch.
   *
   * A failed install was the third route into it, and dismissing is not
   * involved: nobody has to act for the update to stay held. `installFailedRef`
   * releases the check there.
   */
  const dismiss = useCallback(() => {
    pendingRef.current = null;
    installFailedRef.current = false;
    setError(null);
    setErrorKind(null);
    setPhase("idle");
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    void check(true);
    const timer = window.setInterval(() => void check(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [autoCheck, check, intervalMs]);

  return { mode, setMode, phase, version, notes, progress, error, errorKind, check, install, dismiss };
}

// ---- Context so the banner and the Settings toggle share one updater ----

const UpdaterContext = createContext<UpdaterApi | null>(null);

export function UpdaterProvider(props: {
  children: ReactNode;
  intervalMs?: number;
  autoCheck?: boolean;
}) {
  const api = useAppUpdater({ intervalMs: props.intervalMs, autoCheck: props.autoCheck });
  return <UpdaterContext.Provider value={api}>{props.children}</UpdaterContext.Provider>;
}

// A no-op updater for subtrees mounted without a provider (unit tests, plain
// web previews). Matches this module's "safe to always mount" contract rather
// than crashing the whole tree when the provider happens to be absent.
const DISCONNECTED_UPDATER: UpdaterApi = {
  mode: "manual",
  setMode: () => {},
  phase: "idle",
  version: null,
  notes: null,
  progress: 0,
  error: null,
  errorKind: null,
  check: async () => {},
  install: async () => {},
  dismiss: () => {},
};

export function useUpdater(): UpdaterApi {
  return useContext(UpdaterContext) ?? DISCONNECTED_UPDATER;
}

// ---- UI ----

export type BannerCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export function UpdateBanner(props?: { corner?: BannerCorner }) {
  const corner = props?.corner ?? "top-right";
  const { phase, version, progress, error, errorKind, install, dismiss } = useUpdater();

  // A failed check has nothing to report here: it only happens when someone
  // pressed "Check for updates" in Settings, which reports the outcome in the
  // row they pressed (and it is in the app log either way). The corner banner
  // is for an update that was actually being installed, so a check that could
  // not reach the server must not raise "Update failed" over the editor.
  const failedInstall = phase === "error" && errorKind !== "check";
  const active =
    phase === "available"
    || phase === "downloading"
    || phase === "installing"
    || phase === "ready"
    || failedInstall;
  if (!active) return null;

  const pct = Math.round(progress * 100);
  // Progress phases stack the bar under the title so the title never gets
  // squeezed onto a second line / truncated beside the bar.
  const stacked = phase === "downloading" || phase === "installing";

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
          <button type="button" className="app-update-dismiss" aria-label="Dismiss" onClick={dismiss}>
            ×
          </button>
        </>
      )}

      {(phase === "downloading" || phase === "installing") && (
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
          <button type="button" className="app-update-dismiss" aria-label="Dismiss" onClick={dismiss}>
            ×
          </button>
        </>
      )}
    </div>
  );
}
