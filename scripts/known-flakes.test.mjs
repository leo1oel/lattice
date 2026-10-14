import { describe, expect, it } from "vitest";
import { failuresInLog, recentSightings } from "./known-flakes.mjs";

// Lines as GitHub serves a job log: a timestamp, then the runner's colours.
const at = (line) => `2026-10-14T00:01:46.7460905Z ${line}`;

describe("failuresInLog", () => {
  it("names each failing check once, from every job type CI runs", () => {
    const log = [
      at("\x1b[31m     \x1b[31m×\x1b[31m groups by day\x1b[39m"),
      at("\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/overleaf/overleaf-history.test.tsx\x1b[2m > \x1b[22mOverleafHistoryPanel\x1b[2m > \x1b[22mgroups by day"),
      at(" FAIL  src/overleaf/overleaf-history.test.tsx > OverleafHistoryPanel > groups by day"),
      at("test synara::tests::reuses_the_preferred_port_only_while_it_is_free ... FAILED"),
      at("test synara::tests::other ... ok"),
      at("pdf-live-drag-copy: FAILED, the drag did not select from page 1 into page 3"),
      at("  startup hooks: 13003 exceeds ceiling 12910"),
    ].join("\n");
    expect(failuresInLog(log)).toEqual([
      "src/overleaf/overleaf-history.test.tsx > OverleafHistoryPanel > groups by day",
      "synara::tests::reuses_the_preferred_port_only_while_it_is_free",
      "pdf-live-drag-copy",
      "perf-bench ceiling: startup hooks",
    ]);
  });

  it("names nothing in a log without a failing test", () => {
    expect(failuresInLog(at("Error: Process completed with exit code 1."))).toEqual([]);
  });
});

describe("recentSightings", () => {
  it("counts the week's comments that name the check", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const comments = [
      { created_at: "2026-10-13T12:00:00Z", body: "- `test (1/3)`: `a.test.ts > x`" },
      { created_at: "2026-10-01T12:00:00Z", body: "- `test (1/3)`: `a.test.ts > x`" },
      { created_at: "2026-10-14T11:00:00Z", body: "- `rust`: `b::c`" },
    ];
    expect(recentSightings(comments, "a.test.ts > x", now)).toBe(1);
  });
});
