import { addAppLog } from "./app-log-store";
import { isWebBridgeUnavailable } from "../platform/web-bridge";

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
    return value.cause === undefined ? detail : `${detail}\nCaused by: ${formatArg(value.cause)}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function report(level: "error" | "warning", title: string, detail: string) {
  if (handling) return;
  handling = true;
  try {
    addAppLog({ level, source: "App", title, detail, toast: false });
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
    report("error", "Unexpected error", event.error ? formatArg(event.error) : event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    // Native commands invoked in a plain browser reject by design; swallow them
    // so a web deployment does not surface a wall of desktop-only errors.
    if (isWebBridgeUnavailable(event.reason)) {
      event.preventDefault();
      return;
    }
    report("error", "Unhandled promise rejection", formatArg(event.reason));
  });

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args);
    report("error", "console.error", args.map(formatArg).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    report("warning", "console.warn", args.map(formatArg).join(" "));
  };
}
