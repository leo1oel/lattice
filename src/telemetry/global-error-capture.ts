import { msg } from "@lingui/core/macro";
import { addAppLog } from "./app-log-store";
import { translateOr } from "./early-i18n";

let installed = false;
// Recursion guard: if the logging path itself throws (or a wrapped console
// method fires while we're already reporting), drop the report instead of
// looping. Cleared in `finally` so later, unrelated errors still get logged.
let handling = false;

function formatArg(value: unknown): string {
  if (value instanceof Error) {
    const detail = !value.stack || value.stack.includes(value.message)
      ? value.stack ?? value.message
      : `${value.message}\n${value.stack}`;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- part of a stack trace, kept as the runtime prints it
    return value.cause === undefined ? detail : `${detail}\nCaused by: ${formatArg(value.cause)}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function logCapturedProblem(level: "error" | "warning", title: string, detail: string) {
  if (handling) return;
  handling = true;
  try {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- English until a catalog is active
    addAppLog({ level, source: translateOr(msg`App`, "App"), title, detail, toast: false });
  } catch {
    // Logging must never throw back into the app.
  } finally {
    handling = false;
  }
}

function isResizeObserverNotification(message: string): boolean {
  return message === "ResizeObserver loop limit exceeded"
    || message === "ResizeObserver loop completed with undelivered notifications.";
}

/**
 * Routes uncaught errors, unhandled promise rejections, and console.error/warn
 * into the app log (in-app list + on-disk file). Installed once at startup.
 */
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    // Browsers dispatch these as window errors when resize notifications are
    // deferred to the next frame. There is no thrown application exception;
    // logging one on every image/formula layout pass obscures real failures.
    if (isResizeObserverNotification(event.message)) {
      event.preventDefault();
      return;
    }
    // eslint-disable-next-line lingui/no-unlocalized-strings -- English until a catalog is active
    logCapturedProblem("error", translateOr(msg`Unexpected error`, "Unexpected error"), event.error ? formatArg(event.error) : event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- English until a catalog is active
    logCapturedProblem("error", translateOr(msg`Unhandled promise rejection`, "Unhandled promise rejection"), formatArg(event.reason));
  });

  for (const [method, level] of [["error", "error"], ["warn", "warning"]] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      logCapturedProblem(level, `console.${method}`, args.map(formatArg).join(" "));
    };
  }
}
