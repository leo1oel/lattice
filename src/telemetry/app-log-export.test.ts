import { describe, expect, it } from "vitest";
import type { AppLogEntry } from "./app-log-store";
import { createAppLogExport } from "./app-log-export";

const id = "123e4567-e89b-42d3-a456-426614174000";

describe("createAppLogExport", () => {
  it("canonicalizes dates so parsed comments cannot leak into safe metadata", () => {
    const entry: AppLogEntry = { id, timestamp: "2026-01-01 (private document)", level: "info", source: "App", title: "test", detail: "",
      context: { operation_id: id, operation: "logging.delivery", phase: "progress", metrics: { dropped_failed: 3 } } };
    const exported = createAppLogExport([entry]);
    expect(JSON.stringify(exported)).not.toContain("private document");
    expect(exported.entries[0]).toMatchObject({ context: { operation: "logging.delivery", metrics: { dropped_failed: 3 } } });
  });

  it("exports only allowlisted diagnostic fields and metrics", () => {
    const entry = {
      id, timestamp: "2026-09-08T10:00:00.000Z", level: "error",
      source: "/Users/alice/secret.tex", title: "token=secret", detail: "document text",
      context: {
        operation_id: id, operation: "/private/project", phase: "completed", outcome: "error",
        duration_ms: 2100, trigger: "password=hunter2", error_type: "/private/Error",
        metrics: { diagnostics: 2, has_pdf: false, "/home/alice": 3, secret: true, conflicts: Infinity },
      },
    } satisfies AppLogEntry;
    const exported = createAppLogExport([entry]);
    const text = JSON.stringify(exported);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("hunter2");
    expect(exported.entries[0]).toMatchObject({
      level: "error", context: { operation_id: id, phase: "completed", outcome: "error", duration_ms: 2100,
        metrics: { diagnostics: 2, has_pdf: false } },
    });
  });

  it("requires explicit raw inclusion and drops malformed values", () => {
    const entry = {
      id: "not-an-id", timestamp: "bad", level: "mystery", source: "raw source", title: "raw title", detail: "raw detail",
      context: { operation_id: "bad", operation: "bad", phase: "future", duration_ms: -1 },
    } as unknown as AppLogEntry;
    expect(createAppLogExport([entry]).entries[0]).toEqual({});
    expect(createAppLogExport([entry], true).entries[0]).toHaveProperty("raw_diagnostic.detail", "raw detail");
  });
});
