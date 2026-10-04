import { beforeEach, describe, expect, it, vi } from "vitest";

const fileLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@tauri-apps/plugin-log", () => fileLog);

async function written(): Promise<{ level: "info" | "warn"; event: Record<string, unknown> }[]> {
  // The file queue delivers through a dynamic import, a few turns later.
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return (["info", "warn"] as const).flatMap((level) =>
    fileLog[level].mock.calls.map(([line]) => ({ level, event: JSON.parse(line as string) })));
}

describe("startWideEvent", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const write of Object.values(fileLog)) write.mockReset().mockResolvedValue(undefined);
  });

  it("writes one line in the backend's shape, once", async () => {
    const { startWideEvent } = await import("./wide-event");
    const event = startWideEvent("pdf.session", { path: "figures/plot.pdf", file_bytes: 2048 });
    event.add("range_requests");
    event.add("range_requests", 2);
    event.set({ stale: true, skipped: undefined });
    event.end();
    event.end("error");
    const lines = await written();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].event).toMatchObject({
      event: "pdf.session", outcome: "success", path: "figures/plot.pdf", file_bytes: 2048, range_requests: 3, stale: true,
    });
    expect(lines[0].event.duration_ms).toEqual(expect.any(Number));
    expect(lines[0].event).not.toHaveProperty("skipped");
  });

  it("says why a failure happened and what to do, at warning level, without secrets", async () => {
    const { startWideEvent } = await import("./wide-event");
    const event = startWideEvent("pdf.session", { header: "Authorization: Bearer abc.def-secret" });
    event.fail("range_read_failed", new Error("read failed: token=leaked-secret\nl.4 the paper's own words"), "Reopen the PDF.");
    event.end();
    const [line] = await written();
    expect(line.level).toBe("warn");
    expect(line.event).toMatchObject({
      outcome: "error", error_kind: "range_read_failed", error_fix: "Reopen the PDF.",
      error_cause: "read failed: token=[redacted]",
    });
    expect(JSON.stringify(line.event)).not.toMatch(/secret|paper's own words/);
  });
});
