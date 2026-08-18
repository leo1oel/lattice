/**
 * Local seam — not upstream code.
 *
 * Stands in for the `sonner` toast package in vendored Open Knowledge files
 * (see the `from 'sonner'` rewrite in scripts/vendor-open-knowledge.mjs).
 * The host surfaces notifications through its app-log store instead of a
 * sonner Toaster, so the vendored `toast.*` calls route there.
 */
import { addAppLog } from "../../telemetry/app-log-store";

function log(level: "error" | "success" | "info" | "warning", message: unknown): void {
  addAppLog({ level, source: "Editor", title: String(message), toast: true });
}

export const toast = {
  error: (message: unknown) => log("error", message),
  success: (message: unknown) => log("success", message),
  info: (message: unknown) => log("info", message),
  warning: (message: unknown) => log("warning", message),
};
