// In-app auto-update for Lattice, built on tauri-plugin-updater: one
// <UpdaterProvider> (main.tsx) shared by Settings and the update's toast.
//
// Every window has one, so the backend decides which window installs a release
// (src-tauri/src/app_restart.rs). Installing replaces the app on disk; the
// restart that starts using it is always someone's choice, never automatic:
// "Update now" asks for it, and an automatic install offers it. Before
// restarting, a restart that would stop a terminal command, a compile or an
// Agent task says so and waits to be confirmed, and every window saves its
// open edits first (src-tauri/src/save_before_close.rs).
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
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { toMessage } from "../app-utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import { spaceMixedScript } from "../trellis/trellis-titles";
import { loadChoice, persistSetting } from "../settings/app-settings";
import {
  addAppLog,
  dismissAppToastByDedupeKey,
  updateAppToastProgress,
  type AppLogLevel,
  type AppToastOptions,
} from "./app-log-store";

type UpdateMode = "auto" | "manual";
/** `ready`: installed on disk, used from the next launch or a restart. */
type UpdatePhase =
  | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "ready" | "restarting" | "error";

/**
 * Which step produced `error`. Checking and installing both land in the same
 * "error" phase, but only one of them ever downloaded anything: a check that
 * fails because the machine is offline is not a failed update, and saying so
 * tells people an install they never started went wrong.
 */
type UpdateErrorKind = "check" | "install";

const MODE_KEY = "lattice.update.mode.v1";
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// Storage failures fall back to manual, and a choice that cannot be saved still
// applies for this session.
const loadUpdateMode = () => loadChoice<UpdateMode>(MODE_KEY, ["auto"], "manual");

/** Minimal shape of the object returned by `@tauri-apps/plugin-updater`'s check(). */
type TauriUpdate = {
  version: string;
  currentVersion: string;
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
};

export type DownloadEvent =
  | { event: "Started"; data?: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** Lazy-load the updater plugin so a browser/dev build doesn't crash on import. */
async function loadUpdateCheck() {
  return (await import("@tauri-apps/plugin-updater")).check;
}

/** What the backend answers a window asking to install a release; see app_restart.rs. */
type UpdateClaim = "claimed" | "busy" | "installed";

async function claimUpdateInstall(version: string): Promise<UpdateClaim> {
  // A backend without the command (no Tauri runtime, or a release before it)
  // has only this window to install.
  return invoke<UpdateClaim>("claim_update_install", { version }).catch(() => "claimed" as const);
}

function finishUpdateInstall(version: string, installed: boolean) {
  void invoke("finish_update_install", { version, installed }).catch(() => undefined);
}

type RestartImpact = { terminalCommands: number; builds: number; agentTurns: number };

/** What restarting now would stop, as a phrase ("an Agent task and 2 compiles"), or null for nothing. */
async function runningWorkStoppedByRestart(): Promise<string | null> {
  const impact = await invoke<RestartImpact | null>("restart_impact").catch(() => null);
  if (!impact) return null;
  const { agentTurns, terminalCommands, builds } = impact;
  const parts = [
    agentTurns === 1 ? i18n._(msg`an Agent task`) : agentTurns > 1 ? i18n._(msg`${agentTurns} Agent tasks`) : "",
    terminalCommands === 1
      ? i18n._(msg`a terminal command`)
      : terminalCommands > 1 ? i18n._(msg`${terminalCommands} terminal commands`) : "",
    builds === 1 ? i18n._(msg`a compile`) : builds > 1 ? i18n._(msg`${builds} compiles`) : "",
  ].filter(Boolean);
  // "1 个 Agent 任务和 2 次编译": spaced where Han meets a digit.
  return parts.length ? spaceMixedScript(new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(parts)) : null;
}

/**
 * Restart once every window has saved. Resolves only from an older backend;
 * rejects when a window could not save its edits and the restart was called off.
 */
async function restartLattice() {
  try {
    await invoke("restart_lattice");
  } catch (reason) {
    // An updater can replace the app bundle before the old process exits. If
    // that process then reloads the new frontend, an older release does not
    // know this command: v0.1.251 through v0.13 restart with
    // `restart_after_update`, and releases before those through the process
    // plugin. Neither saves first, as those releases never did.
    if (toMessage(reason) !== "Command restart_lattice not found") throw reason;
    try {
      await invoke("restart_after_update");
    } catch (older) {
      if (toMessage(older) !== "Command restart_after_update not found") throw older;
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    }
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
  /** Restart into the installed update, warning first about work a restart would stop. */
  restart: () => Promise<void>;
  /** Put the offered update (or a failed one) away without installing. */
  dismiss: () => void;
};

const IDLE: UpdaterState = { phase: "idle", version: null, progress: 0, error: null, errorKind: null };
const FAILURE_TITLES: Record<UpdateErrorKind, MessageDescriptor> = {
  check: msg`Couldn’t check for Lattice updates`,
  install: msg`Lattice update failed`,
};

/**
 * Every phase of one update is the same toast, updated in place: the offer
 * becomes the download's progress bar, then "Installing…", then either the
 * restart or the failure. The phases are log entries (each is something that
 * happened); the download's per-chunk progress only moves the bar.
 */
const UPDATE_TOAST = "app-update";

function showUpdateToast(level: AppLogLevel, title: string, detail: string, toastOptions: AppToastOptions) {
  addAppLog({ level, source: i18n._(msg`App updater`), title, detail, dedupeKey: UPDATE_TOAST, toastOptions });
}

/** The installed update, waiting for a restart. Closing it is Later: the update applies at the next launch. */
function showRestartOffer(version: string, restart: () => void) {
  showUpdateToast("info", i18n._(msg`Lattice ${version} is ready`), i18n._(msg`Restart to finish updating. Otherwise the update applies the next time Lattice opens.`), {
    timeoutMs: 0,
    primaryAction: { label: i18n._(msg`Restart now`), onClick: restart, keepOpen: true },
  });
}

function useAppUpdater(intervalMs = DEFAULT_CHECK_INTERVAL_MS, autoCheck = true): UpdaterApi {
  const [mode, setModeState] = useState<UpdateMode>(loadUpdateMode);
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
  /** The held update is installed on disk; only a restart is left. */
  const installedRef = useRef(false);
  /** A restart is being checked for running work, or under way. */
  const restartingRef = useRef(false);
  const modeRef = useLatestRef(mode);

  const patch = useCallback((next: Partial<UpdaterState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);
  /**
   * Put the update away, and let checking resume.
   *
   * `check` returns early while `pendingRef` holds an update, so a dismissed
   * update has to be released here or no later check — the six-hourly one or
   * the button in Settings — could notice a release for the rest of the
   * session. Dismissing the failure toast lands here too.
   */
  const dismiss = useCallback(() => {
    pendingRef.current = null;
    installFailedRef.current = false;
    installedRef.current = false;
    patch({ phase: "idle", error: null, errorKind: null });
    dismissAppToastByDedupeKey(UPDATE_TOAST);
  }, [patch]);
  const fail = useCallback((errorKind: UpdateErrorKind, reason: unknown) => {
    const detail = toMessage(reason);
    patch({ phase: "error", error: detail, errorKind });
    // A failed check has nothing to show over the editor: it only happens when
    // someone pressed "Check for updates" in Settings, which reports the
    // outcome in the row they pressed. Only an install that was under way
    // turns its toast into the failure.
    const title = i18n._(FAILURE_TITLES[errorKind]);
    if (errorKind === "install") showUpdateToast("error", title, detail, { timeoutMs: 0, onDismiss: dismiss });
    else addAppLog({ level: "error", source: i18n._(msg`App updater`), title, detail, toast: false });
  }, [dismiss, patch]);

  /**
   * Restart into the installed update. `confirmed` skips the warning about
   * work still running, which is where the warning's own button comes back.
   */
  const restart = useCallback((confirmed = false) => {
    const attempt = async (confirmed: boolean): Promise<void> => {
      const update = pendingRef.current;
      if (!update || !installedRef.current || restartingRef.current) return;
      restartingRef.current = true;
      const { version } = update;
      const running = confirmed ? null : await runningWorkStoppedByRestart();
      if (running) {
        restartingRef.current = false;
        // Closing the warning keeps the update for the next launch, as Later would.
        showUpdateToast("warning", i18n._(msg`Restart Lattice now?`), i18n._(msg`Restarting now stops ${running}.`), {
          timeoutMs: 0,
          primaryAction: { label: i18n._(msg`Restart anyway`), onClick: () => void attempt(true), keepOpen: true },
        });
        return;
      }
      patch({ phase: "restarting" });
      showUpdateToast("info", i18n._(msg`Restarting…`), i18n._(msg`Version ${version}`), { timeoutMs: 0, progress: "indeterminate" });
      try {
        await restartLattice();
      } catch {
        // A window could not save an edit, and says so itself: Lattice stays
        // open, with the restart still on offer.
        restartingRef.current = false;
        patch({ phase: "ready" });
        showRestartOffer(version, () => void attempt(false));
      }
    };
    return attempt(confirmed);
  }, [patch]);

  /** Download and install the pending update; `restartAfter` then restarts into it. */
  const installUpdate = useCallback(async (restartAfter: boolean) => {
    const update = pendingRef.current;
    if (!update || installingRef.current) return;
    if (installedRef.current) {
      if (restartAfter) await restart();
      return;
    }
    installingRef.current = true;
    installFailedRef.current = false;
    const { version } = update;
    const versionLine = i18n._(msg`Version ${version}`);
    const installed = async () => {
      installingRef.current = false;
      installedRef.current = true;
      patch({ phase: "ready" });
      if (restartAfter) await restart();
      else showRestartOffer(version, () => void restart());
    };
    const claim = await claimUpdateInstall(version);
    if (claim === "installed") {
      await installed();
      return;
    }
    if (claim === "busy") {
      // Another window is installing it. Let go of the update, so the next
      // check here hears it is installed instead of holding the offer.
      installingRef.current = false;
      pendingRef.current = null;
      patch({ phase: "idle" });
      if (restartAfter) showUpdateToast("info", i18n._(msg`Another Lattice window is installing this update.`), versionLine, {});
      else dismissAppToastByDedupeKey(UPDATE_TOAST);
      return;
    }
    patch({ phase: "downloading", progress: 0 });
    // Closing a running update's toast only hides it; the update carries on.
    showUpdateToast("info", i18n._(msg`Downloading update…`), versionLine, { timeoutMs: 0, progress: "indeterminate" });
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data?.contentLength ?? 0;
          if (total > 0) updateAppToastProgress(UPDATE_TOAST, 0);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) {
            const progress = Math.min(1, received / total);
            patch({ progress });
            updateAppToastProgress(UPDATE_TOAST, progress);
          }
        } else if (event.event === "Finished") {
          patch({ phase: "installing", progress: 1 });
          showUpdateToast("info", i18n._(msg`Installing…`), versionLine, { timeoutMs: 0, progress: "indeterminate" });
        }
      });
    } catch (reason) {
      finishUpdateInstall(version, false);
      installingRef.current = false;
      installFailedRef.current = true;
      fail("install", reason);
      return;
    }
    finishUpdateInstall(version, true);
    await installed();
  }, [fail, patch, restart]);

  const install = useCallback(() => installUpdate(true), [installUpdate]);

  const setMode = useCallback((next: UpdateMode) => {
    setModeState(next);
    persistSetting(MODE_KEY, next);
    // Switching to automatic while an update is already waiting installs it now.
    if (next === "auto" && pendingRef.current && !installingRef.current) {
      void installUpdate(false);
    }
  }, [installUpdate]);

  const check = useCallback(async (silent = true) => {
    // A held update is what stops a second offer for one already offered —
    // but only while it is still installable. Once its install has failed the
    // toast is a failure, and holding the check hostage to it means
    // the next release is never noticed for the rest of the session.
    if (installingRef.current || installedRef.current) return;
    if (pendingRef.current && !installFailedRef.current) return;
    try {
      const checkForUpdate = await loadUpdateCheck();
      if (!silent) patch({ phase: "checking" });
      const update = (await checkForUpdate()) as TauriUpdate | null;
      if (update?.version && update.version !== update.currentVersion) {
        pendingRef.current = update;
        installFailedRef.current = false;
        patch({ phase: "available", version: update.version, error: null, errorKind: null });
        if (modeRef.current === "auto") void installUpdate(false);
        else {
          const { version } = update;
          // The title and Update now say all there is: no detail line.
          showUpdateToast("info", i18n._(msg`New version ${version}`), "", {
            timeoutMs: 0,
            // The toast stays to carry the download that this starts.
            primaryAction: { label: i18n._(msg`Update now`), onClick: () => void install(), keepOpen: true },
            onDismiss: dismiss,
          });
        }
      } else if (!silent) {
        patch({ phase: "up-to-date" });
      }
    } catch (reason) {
      // Browser/dev (no Tauri) or a transient network error: stay quiet unless
      // the user explicitly pressed "Check for updates".
      if (!silent) fail("check", reason);
    }
  }, [dismiss, fail, install, installUpdate, modeRef, patch]);

  useEffect(() => {
    if (!autoCheck) return;
    void check(true);
    const timer = window.setInterval(() => void check(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [autoCheck, check, intervalMs]);

  const restartNow = useCallback(() => restart(), [restart]);

  return { ...state, mode, setMode, check, install, restart: restartNow, dismiss };
}

// ---- Context so the update toast and the Settings toggle share one updater ----

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
  restart: async () => {},
  dismiss: () => {},
};

export function useUpdater(): UpdaterApi {
  return useContext(UpdaterContext) ?? DISCONNECTED_UPDATER;
}
