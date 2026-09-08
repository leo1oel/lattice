import { version } from "../../package.json";
import type { AppLogEntry } from "./app-log-store";

const LEVELS = new Set(["info", "success", "warning", "error"]);
const PHASES = new Set(["started", "progress", "completed"]);
const OUTCOMES = new Set(["success", "error", "cancelled"]);
const SAFE_METRICS = new Set([
  "automatic", "shared", "pulled", "pushed", "merged", "conflicts", "deleted_local",
  "read_only", "retry_scheduled", "force", "compiler_duration_ms", "diagnostics", "has_pdf",
  "status_code", "dropped_overflow", "dropped_failed",
]);
const SAFE_OPERATIONS = new Set([
  "Build", "Sync", "logging.delivery", "build_project", "overleaf_sync", "overleaf_prepare_sync", "overleaf_commit_prepared_sync",
  "collab.create", "collab.catalog", "collab.presence", "collab.events", "collab.grants", "collab.text.import", "collab.binary.import", "collab.import.control",
  "collab.binary.upload", "collab.binary.download", "collab.binary/upload-tickets", "collab.binary/read-tickets", "collab.binary/commit",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_COUNT = 1_000_000_000;

export type AppLogExport = {
  schema_version: 1;
  app_version: string;
  exported_at: string;
  includes_raw_diagnostic: boolean;
  entries: Record<string, unknown>[];
};

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeMetrics(value: unknown): Record<string, number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, number | boolean> = {};
  for (const [key, metric] of Object.entries(value)) {
    if (!SAFE_METRICS.has(key)) continue;
    if (typeof metric === "boolean") result[key] = metric;
    else if (typeof metric === "number" && Number.isFinite(metric) && metric >= 0 && metric <= MAX_COUNT) {
      result[key] = metric;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/** Builds a new allowlisted object. Never spread persisted, potentially old data. */
export function createAppLogExport(entries: readonly AppLogEntry[], includeRawDiagnostic = false): AppLogExport {
  return {
    schema_version: 1,
    app_version: version,
    exported_at: new Date().toISOString(),
    includes_raw_diagnostic: includeRawDiagnostic,
    entries: entries.map((entry) => {
      const output: Record<string, unknown> = {};
      if (UUID.test(entry.id)) output.id = entry.id;
      if (validDate(entry.timestamp)) output.timestamp = new Date(entry.timestamp).toISOString();
      if (LEVELS.has(entry.level)) output.level = entry.level;
      const context = entry.context;
      if (context && typeof context === "object") {
        const safe: Record<string, unknown> = {};
        if (SAFE_OPERATIONS.has(context.operation)) safe.operation = context.operation;
        if (UUID.test(context.operation_id)) safe.operation_id = context.operation_id;
        if (typeof context.request_id === "string" && UUID.test(context.request_id)) safe.request_id = context.request_id;
        if (typeof context.parent_request_id === "string" && UUID.test(context.parent_request_id)) safe.parent_request_id = context.parent_request_id;
        if (PHASES.has(context.phase)) safe.phase = context.phase;
        if (context.outcome && OUTCOMES.has(context.outcome)) safe.outcome = context.outcome;
        if (typeof context.duration_ms === "number" && Number.isFinite(context.duration_ms)
          && context.duration_ms >= 0 && context.duration_ms <= MAX_DURATION_MS) safe.duration_ms = context.duration_ms;
        const metrics = safeMetrics(context.metrics);
        if (metrics) safe.metrics = metrics;
        if (Object.keys(safe).length) output.context = safe;
      }
      if (includeRawDiagnostic) {
        output.raw_diagnostic = {
          source: typeof entry.source === "string" ? entry.source : "",
          title: typeof entry.title === "string" ? entry.title : "",
          detail: typeof entry.detail === "string" ? entry.detail : "",
          ...(context && typeof context === "object" ? {
            trigger: typeof context.trigger === "string" ? context.trigger : undefined,
            error_type: typeof context.error_type === "string" ? context.error_type : undefined,
          } : {}),
        };
      }
      return output;
    }),
  };
}

export function serializeAppLogExport(entries: readonly AppLogEntry[], includeRawDiagnostic = false): string {
  return JSON.stringify(createAppLogExport(entries, includeRawDiagnostic), null, 2);
}
