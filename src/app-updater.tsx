// In-app auto-update for Lattice, built on tauri-plugin-updater.
//
// Provides:
//   <UpdaterProvider>        wrap your app once (main.tsx)
//   <UpdateBanner corner />  the corner "new version" popup + one-click update
//   <UpdateModeSetting />    the Settings toggle: automatic vs manual
//   useUpdater()             read/drive the updater from anywhere
//
// It does NOT require an Apple Developer account — the updater verifies packages
// with its own free signing key (see AUTO-UPDATE-SETUP.md). In a plain web/dev
// build (no Tauri runtime) every call no-ops, so this is safe to always mount.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

export type UpdateMode = "auto" | "manual";
export type UpdatePhase =
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

export function getUpdateMode(): UpdateMode {
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

/** Lazy-load the Tauri plugins so a browser/dev build doesn't crash on import. */
async function loadUpdaterApis() {
  const [updater, process] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);
  return { check: updater.check, relaunch: process.relaunch };
}

export type UpdaterApi = {
  mode: UpdateMode;
  setMode: (mode: UpdateMode) => void;
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  progress: number; // 0..1
  error: string | null;
  /** Check now. `silent` (default) never surfaces "up to date"/errors. */
  check: (silent?: boolean) => Promise<void>;
  /** Download + install the pending update, then relaunch. Safe to call once. */
  install: () => Promise<void>;
  /** Hide the "available" banner without installing. */
  dismiss: () => void;
};

export function useAppUpdater(options?: {
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

  const pendingRef = useRef<TauriUpdate | null>(null);
  const installingRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const setMode = useCallback((next: UpdateMode) => {
    setModeState(next);
    persistUpdateMode(next);
    // Switching to automatic while an update is already waiting installs it now.
    if (next === "auto" && pendingRef.current && !installingRef.current) {
      void installRef.current();
    }
  }, []);

  const install = useCallback(async () => {
    const update = pendingRef.current;
    if (!update || installingRef.current) return;
    installingRef.current = true;
    try {
      const { relaunch } = await loadUpdaterApis();
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
      await relaunch();
    } catch (reason) {
      installingRef.current = false;
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("error");
    }
  }, []);

  // Ref indirection so setMode/check can call the latest install without a dep cycle.
  const installRef = useRef(install);
  installRef.current = install;

  const check = useCallback(async (silent = true) => {
    if (pendingRef.current || installingRef.current) return;
    try {
      const { check: checkForUpdate } = await loadUpdaterApis();
      if (!silent) setPhase("checking");
      const update = (await checkForUpdate()) as TauriUpdate | null;
      if (update && update.version && update.version !== update.currentVersion) {
        pendingRef.current = update;
        setVersion(update.version);
        setNotes(update.body ?? null);
        setError(null);
        setPhase("available");
        if (modeRef.current === "auto") void installRef.current();
      } else if (!silent) {
        setPhase("up-to-date");
      }
    } catch (reason) {
      // Browser/dev (no Tauri) or a transient network error: stay quiet unless
      // the user explicitly pressed "Check for updates".
      if (!silent) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase("error");
      }
    }
  }, []);

  const dismiss = useCallback(() => {
    setPhase((current) => (current === "available" ? "idle" : current));
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    void check(true);
    const timer = window.setInterval(() => void check(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [autoCheck, check, intervalMs]);

  return { mode, setMode, phase, version, notes, progress, error, check, install, dismiss };
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
  const { phase, version, progress, error, install, dismiss } = useUpdater();

  const active =
    phase === "available"
    || phase === "downloading"
    || phase === "installing"
    || phase === "ready"
    || phase === "error";
  if (!active) return null;

  const pct = Math.round(progress * 100);
  // Progress phases stack the bar under the title so the title never gets
  // squeezed onto a second line / truncated beside the bar.
  const stacked = phase === "downloading" || phase === "installing";

  return (
    <div className={`app-update-banner ${corner}${stacked ? " stacked" : ""}`} role="status" aria-live="polite">
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
            <strong>{phase === "installing" ? "Installing…" : "Downloading update…"}</strong>
            <span>{phase === "downloading" ? `${pct}%` : "Almost done"}</span>
          </div>
          <div className="app-update-progress">
            <div className="app-update-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}

      {phase === "ready" && (
        <div className="app-update-text">
          <strong>Restarting…</strong>
        </div>
      )}

      {phase === "error" && (
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

/** Drop into your Settings panel. Toggles automatic vs manual updates. */
export function UpdateModeSetting() {
  const { mode, setMode, phase, check } = useUpdater();
  return (
    <div className="app-update-setting">
      <label>
        Updates
        <Select value={mode} onValueChange={(value) => setMode(value as UpdateMode)}>
          <SelectTrigger aria-label="Updates"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value="manual">Notify me (manual)</SelectItem>
            <SelectItem value="auto">Install automatically</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <button
        type="button"
        className="text-button"
        disabled={phase === "checking" || phase === "downloading"}
        onClick={() => void check(false)}
      >
        {phase === "checking" ? "Checking…" : phase === "up-to-date" ? "Up to date" : "Check now"}
      </button>
    </div>
  );
}
