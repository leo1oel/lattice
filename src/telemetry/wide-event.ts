/**
 * One wide log event per UI-side operation, in the shape the backend writes
 * (`src-tauri/src/wide_event.rs`): a single JSON line
 * `{"event","outcome","duration_ms",…fields}`, plus `error_kind`, `error_cause`
 * and `error_fix` when it failed. It goes to lattice.log only — no in-app
 * entry, no toast — so use it for operations worth a line in a bug report,
 * not for every console call.
 *
 * Fields are counts, sizes, flags and project-relative paths. Never put
 * document text, credentials or absolute paths in one; strings are passed
 * through `redactLogText` anyway, as a backstop.
 */
import { redactLogText, writeLogFileLine } from "./app-log-store";
import { toMessage } from "../app-utils";

export type WideEventValue = string | number | boolean;
export type WideEventOutcome = "success" | "error" | "cancelled";

export type WideEvent = {
  /** Set fields; `undefined` leaves a field out. */
  set: (fields: Record<string, WideEventValue | undefined>) => void;
  /** Add to a counter field. */
  add: (key: string, amount?: number) => void;
  /** Mark the operation failed: a stable kind, why, and what the user can do. */
  fail: (kind: string, cause: unknown, fix: string) => void;
  /** Write the event. Only the first call writes; later ones do nothing. */
  end: (outcome?: WideEventOutcome) => void;
};

const MAX_STRING = 400;
const MAX_CAUSE = 240;

function clean(value: string, limit: number): string {
  const text = redactLogText(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function startWideEvent(event: string, initial: Record<string, WideEventValue | undefined> = {}): WideEvent {
  const started = performance.now();
  const fields = new Map<string, WideEventValue>();
  let failed = false;
  let ended = false;
  const set: WideEvent["set"] = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) fields.set(key, typeof value === "string" ? clean(value, MAX_STRING) : value);
    }
  };
  set(initial);
  return {
    set,
    add: (key, amount = 1) => {
      const current = fields.get(key);
      fields.set(key, (typeof current === "number" ? current : 0) + amount);
    },
    fail: (kind, cause, fix) => {
      failed = true;
      const firstLine = toMessage(cause).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
      fields.set("error_kind", kind);
      fields.set("error_cause", clean(firstLine, MAX_CAUSE));
      fields.set("error_fix", fix);
    },
    end: (outcome) => {
      if (ended) return;
      ended = true;
      const resolved = outcome ?? (failed ? "error" : "success");
      const line = JSON.stringify({
        event,
        outcome: resolved,
        duration_ms: Math.round(performance.now() - started),
        ...Object.fromEntries(fields),
      });
      writeLogFileLine(line, resolved === "error" ? "warning" : "info");
    },
  };
}
