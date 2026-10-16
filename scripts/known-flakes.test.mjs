import { describe, expect, it } from "vitest";
import { failuresInLog, headline, recentSightings } from "./known-flakes.mjs";

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

describe("headline", () => {
  const run = {
    id: 38851281856,
    name: "CI",
    html_url: "https://github.com/o/r/actions/runs/38851281856",
    head_sha: "219ac99d0123",
    head_branch: "fix/reopen",
    pull_requests: [{ number: 385 }],
  };
  const where = "[CI run 38851281856](https://github.com/o/r/actions/runs/38851281856/attempts/1) · `219ac99`";

  it("names the pull request a passing re-run came from", () => {
    expect(headline("pr-rerun", 1, run)).toBe(
      `**Flaky on pull request #385**: attempt 1 failed, a re-run of the same commit passed · ${where}`,
    );
  });

  it("falls back to the branch for a fork's pull request, which the run does not link", () => {
    expect(headline("pr-rerun", 1, { ...run, pull_requests: [] })).toContain("**Flaky on `fix/reopen`**");
  });

  it("keeps main's re-run and the hunt apart from pull requests", () => {
    expect(headline("rerun", 1, run)).toMatch(/^\*\*Flaky on main\*\*: .* · \[CI run /);
    expect(headline("hunt", 1, { ...run, name: "Flake hunt" })).toMatch(/^\*\*Failed in the nightly flake hunt\*\* · \[Flake hunt run /);
  });
});
