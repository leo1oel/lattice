// What the updater does once a check or an install has failed: decide whether
// the failure is worth another attempt, wait and try again, and otherwise say
// what happened and what to do about it. Loaded only when something failed
// (and for the install's log line), so none of it costs the first paint.
//
// GitHub's release server answers the odd request with a 502/503/504, or
// drops the connection, and an hour later serves the same file (issue #730).
// Those are retried quietly. Nothing else is: a 404 will be a 404 again, and
// an update whose signature does not verify must never be fetched in a loop
// until one happens to pass.

import { msg } from "@lingui/core/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import type { AppToastOptions } from "./app-log-store";
import { startWideEvent } from "./wide-event";

/** The waits before the second and third attempts; three attempts in all. */
export const RETRY_DELAYS_MS = [2_000, 6_000];

export const releasePageUrl = (version: string) => `https://github.com/leo1oel/lattice/releases/tag/v${version}`;

type FailureKind = "signature" | "not-found" | "server" | "network" | "other";

export type UpdateFailure = {
  kind: FailureKind;
  /** The HTTP status the server answered, when the error names one. */
  status?: number;
  /** Worth trying again in a few seconds. */
  transient: boolean;
};

// tauri-plugin-updater's own wordings (updater.rs, error.rs) and reqwest's.
const SIGNATURE = /signature|minisign|public key/i;
const STATUS = /\bstatus(?: code)?:?\s*(\d{3})\b/i;
const NETWORK = /timed? ?out|timeout|connection (?:reset|closed|refused|aborted)|error sending request|broken pipe|body error|error decoding response body|network connection was lost/i;
/**
 * A check whose endpoint answered anything but success. The plugin logs
 * "update endpoint did not respond with a successful status code" and throws
 * this without the status, so a 404 on latest.json cannot be told from a 504
 * here. It is retried: the check is quiet, three attempts at most, and a
 * missing latest.json would be a broken release, not something to give up on.
 */
// eslint-disable-next-line lingui/no-unlocalized-strings -- the plugin's English, matched as data
const RELEASE_NOT_FOUND = "Could not fetch a valid release JSON from the remote";

export function classifyUpdateFailure(reason: unknown): UpdateFailure {
  const message = toMessage(reason);
  // Checked first: a verification failure stays final whatever else it says.
  if (SIGNATURE.test(message)) return { kind: "signature", transient: false };
  const status = STATUS.exec(message)?.[1];
  if (status) {
    const code = Number(status);
    if (code === 404) return { kind: "not-found", status: code, transient: false };
    if (code === 502 || code === 503 || code === 504) return { kind: "server", status: code, transient: true };
    return { kind: "other", status: code, transient: false };
  }
  if (message.includes(RELEASE_NOT_FOUND)) return { kind: "server", transient: true };
  if (NETWORK.test(message)) return { kind: "network", transient: true };
  return { kind: "other", transient: false };
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const stop = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * After `first` failed, try `attempt` again while each failure is transient,
 * once per delay. Resolves with the first success; otherwise rejects with the
 * last failure — also when `signal` aborts, which stops at once, mid-wait.
 * `onRetry` hears the number of each attempt (2, 3) before its wait starts.
 */
export async function retryTransient<T>(
  first: unknown,
  attempt: () => Promise<T>,
  options: { signal: AbortSignal; delaysMs?: readonly number[]; onRetry?: (attempt: number) => void },
): Promise<T> {
  let failure = first;
  for (const [index, delay] of (options.delaysMs ?? RETRY_DELAYS_MS).entries()) {
    if (options.signal.aborted || !classifyUpdateFailure(failure).transient) break;
    options.onRetry?.(index + 2);
    if (!(await pause(delay, options.signal))) break;
    try {
      return await attempt();
    } catch (reason) {
      failure = reason;
    }
  }
  throw failure;
}

/**
 * After an install's first download failed: download again while the failures
 * are transient, each time under a new claim — the failed attempt released its
 * own (app_restart.rs). The update's toast says it is trying again, and can
 * cancel the wait.
 */
export function retryInstall(first: unknown, install: {
  version: string;
  signal: AbortSignal;
  /** Aborts `signal`: the toast's Cancel. */
  cancel: () => void;
  attempt: () => Promise<void>;
  claim: (version: string) => Promise<"claimed" | "busy" | "installed">;
  /** Puts the update's toast up as "Downloading update…" with this detail and options. */
  showDownloading: (detail: string, options: AppToastOptions) => void;
}): Promise<void> {
  const { version } = install;
  const downloading = (detail: string, cancel?: () => void) => install.showDownloading(detail, {
    timeoutMs: 0,
    progress: "indeterminate",
    ...cancel ? { primaryAction: { label: i18n._(msg`Cancel`), onClick: cancel } } : {},
  });
  return retryTransient(first, async () => {
    const again = await install.claim(version);
    if (again === "installed") return;
    if (again === "busy") throw new Error(i18n._(msg`Another Lattice window is installing this update.`));
    downloading(i18n._(msg`Version ${version}`));
    await install.attempt();
  }, {
    signal: install.signal,
    onRetry: (next) => {
      downloading(i18n._(msg`Trying again (${next} of 3)…`), install.cancel);
    },
  });
}

/** What happened, in words, and what to do about it. */
export function describeInstallFailure(reason: unknown, version: string): string {
  const { kind, status } = classifyUpdateFailure(reason);
  if (kind === "server" && status === 504) {
    return i18n._(msg`GitHub’s download server timed out (504). Try again, or download Lattice ${version} from the releases page.`);
  }
  if (kind === "server") {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- a status class, not words
    const code = status ?? "5xx";
    return i18n._(msg`GitHub’s download server was unavailable (${code}). Try again, or download Lattice ${version} from the releases page.`);
  }
  if (kind === "network") {
    return i18n._(msg`The download was interrupted: the connection timed out or dropped. Try again, or download Lattice ${version} from the releases page.`);
  }
  if (kind === "not-found") {
    return i18n._(msg`The update file is missing from GitHub’s download server (404). Download Lattice ${version} from the releases page.`);
  }
  if (kind === "signature") {
    return i18n._(msg`The downloaded update failed its signature check, so it was not installed. Download Lattice ${version} from the releases page.`);
  }
  const cause = toMessage(reason).trim().replace(/\.$/, "");
  return i18n._(msg`${cause}. Try again, or download Lattice ${version} from the releases page.`);
}

/**
 * The failed install's toast. It stays until closed, and closing it keeps the
 * update: Try again, or Lattice ▸ Check for Updates…, resumes it.
 */
export function installFailureToast(reason: unknown, version: string, retry: () => void): { detail: string; options: AppToastOptions } {
  const { kind } = classifyUpdateFailure(reason);
  return {
    detail: describeInstallFailure(reason, version),
    options: {
      timeoutMs: 0,
      // Fetching the same file again cannot fix a 404 or a bad signature.
      ...kind === "not-found" || kind === "signature" ? {} : {
        primaryAction: { label: i18n._(msg`Try again`), onClick: retry, keepOpen: true },
      },
      secondaryAction: { label: i18n._(msg`Open releases page`), onClick: () => void openUrl(releasePageUrl(version)) },
    },
  };
}

/** The install's `lattice::event` line, like latex.compile's and overleaf.sync's. */
export function startInstallEvent(fields: { version: string; mode: string }): {
  finish: (result: { outcome: "success" | "error" | "cancelled"; attempts: number; bytes: number; reason?: unknown }) => void;
} {
  const event = startWideEvent("app.update_install", { to_version: fields.version, mode: fields.mode });
  return {
    finish: ({ outcome, attempts, bytes, reason }) => {
      event.set({ attempts, bytes });
      if (reason !== undefined) {
        const failure = classifyUpdateFailure(reason);
        event.set({ http_status: failure.status });
        if (outcome === "error") {
          /* eslint-disable lingui/no-unlocalized-strings -- the log line's fix, in the log's English */
          event.fail(`update_${failure.kind.replace("-", "_")}`, reason, failure.transient
            ? "Try again later, or download the release from GitHub."
            : "Download the release from GitHub.");
          /* eslint-enable lingui/no-unlocalized-strings */
        }
      }
      event.end(outcome);
    },
  };
}
