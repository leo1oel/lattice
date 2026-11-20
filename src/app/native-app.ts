/**
 * The native Lattice, offered to Apple-silicon Macs.
 *
 * From 0.19.0 each release also carries the native app (GPUI, drawn by the Mac
 * instead of a web page) with its own updater feed. Moving to it is the
 * writer's choice: the first launch after an update to 0.19.0 or later offers
 * it once (native-app-dialog.tsx), and Settings ▸ Editor & builds offers it
 * any time. Neither is on the startup path: use-native-app-offer.ts loads
 * this module after the first paint, and Settings loads with it. The backend finds the release (check_native_app, native_app.rs)
 * and installs it through the updater's own claim, install and restart.
 *
 * Whether it is on offer at all is the backend's to say: off Apple silicon
 * both commands answer no, and the page never guesses from its user agent,
 * which WebKit reports as an Intel Mac on every Mac.
 */
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { compareVersions, RUNNING_VERSION, updatedFromThisLaunch } from "./whats-new";

/** A native release a check found, held by the backend under `rid` until installed or released. */
export type NativeAppRelease = { version: string; rid: number };

/** The first release that ships the native app beside this one. */
const FIRST_NATIVE_VERSION = "0.19.0";

const OFFER_KEY = "lattice.native-app-offer.v1";

/**
 * What became of the automatic offer. `declinedAt`: Not now, at that version;
 * only a later update offers again. `stop`: Don't ask again, or the writer
 * switched (anyone who came back from the native app knows Settings keeps the
 * way there); either way it is never offered by itself again.
 */
export type NativeOfferRecord = { declinedAt?: string; stop?: "never" | "switched" };

export function loadNativeOfferRecord(): NativeOfferRecord {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OFFER_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return {};
    const { declinedAt, stop } = parsed as Record<string, unknown>;
    return {
      ...(typeof declinedAt === "string" ? { declinedAt } : {}),
      ...(stop === "never" || stop === "switched" ? { stop } : {}),
    };
  } catch {
    return {};
  }
}

function saveNativeOfferRecord(record: NativeOfferRecord) {
  try {
    localStorage.setItem(OFFER_KEY, JSON.stringify(record));
  } catch {
    // Unsaved, the offer may come back after the next update; nothing worse.
  }
}

/** Not now (`later`) or Don't ask again (`never`), answered at `running`. */
export function declineNativeApp(choice: "later" | "never", running = RUNNING_VERSION) {
  const record = loadNativeOfferRecord();
  saveNativeOfferRecord(choice === "never" ? { ...record, stop: "never" } : { ...record, declinedAt: running });
}

export function recordSwitchToNativeApp() {
  saveNativeOfferRecord({ ...loadNativeOfferRecord(), stop: "switched" });
}

/**
 * Whether this launch offers the native app by itself: the first launch after
 * an update (`updatedFrom`, the version it came from) to 0.19.0 or later,
 * unless the writer said never, switched already, or said Not now at this
 * version or a later one.
 */
export function shouldAutoOfferNativeApp(updatedFrom: string | null, running: string, record: NativeOfferRecord): boolean {
  if (!updatedFrom || record.stop) return false;
  if (compareVersions(running, FIRST_NATIVE_VERSION) < 0) return false;
  return !record.declinedAt || compareVersions(running, record.declinedAt) > 0;
}

/** The native release to switch to; null off Apple silicon, without one, or when the check failed. */
export function checkNativeApp(): Promise<NativeAppRelease | null> {
  return invoke<NativeAppRelease | null>("check_native_app").catch(() => null);
}

/** Let the backend drop a release that will not be installed. */
export function releaseNativeApp(release: NativeAppRelease) {
  void invoke("plugin:resources|close", { rid: release.rid }).catch(() => {});
}

// Asked once per page: the answer is fixed by the build.
let supported = false;
let asked = false;
const supportListeners = new Set<() => void>();

function subscribeSupport(listener: () => void) {
  supportListeners.add(listener);
  if (!asked) {
    asked = true;
    void invoke<boolean>("native_app_supported").then((answer) => answer === true, () => false).then((answer) => {
      supported = answer;
      for (const notify of supportListeners) notify();
    });
  }
  return () => { supportListeners.delete(listener); };
}

/** Whether this build may switch to the native app; false until the backend has said. */
export function useNativeAppSupported(): boolean {
  return useSyncExternalStore(subscribeSupport, () => supported, () => false);
}

/**
 * The release to offer by itself this launch: null unless the launch qualifies
 * (`shouldAutoOfferNativeApp`) and the check finds one.
 */
export async function autoOfferNativeApp(): Promise<NativeAppRelease | null> {
  if (!shouldAutoOfferNativeApp(updatedFromThisLaunch(), RUNNING_VERSION, loadNativeOfferRecord())) return null;
  return checkNativeApp();
}
