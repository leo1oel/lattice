import { beforeEach, describe, expect, it, vi } from "vitest";

const fileLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-log", () => fileLog);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// PDF.js's transport base, reduced to the hook the session calls.
vi.mock("./pdfjs-runtime", () => ({
  PDFDataRangeTransport: class {
    constructor(readonly length: number) {}
    onDataRange(_begin: number, _bytes: Uint8Array) {}
  },
}));

async function settle(): Promise<void> {
  // Reads resolve, then the file queue delivers through a dynamic import.
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function written(): { level: "info" | "warn"; event: Record<string, unknown> }[] {
  return (["info", "warn"] as const).flatMap((level) =>
    fileLog[level].mock.calls.map(([line]) => ({ level, event: JSON.parse(line as string) })));
}

const file = { path: "out/main.pdf", length: 100, version: "v1" };

describe("projectPdfTransport's pdf.session event", () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    for (const write of Object.values(fileLog)) write.mockReset().mockResolvedValue(undefined);
  });

  it("writes one line when the viewer tears the document down, with reads and bytes", async () => {
    invoke.mockImplementation(async (_command: string, range: { start: number; end: number }) =>
      new ArrayBuffer(range.end - range.start));
    const { projectPdfTransport } = await import("./project-pdf");
    const onError = vi.fn();
    const transport = projectPdfTransport(file, onError);
    const delivered = vi.spyOn(transport, "onDataRange");
    transport.requestDataRange(0, 40);
    transport.requestDataRange(40, 100);
    await settle();
    expect(written()).toHaveLength(0);
    transport.abort();
    transport.abort();
    await settle();
    expect(delivered).toHaveBeenCalledTimes(2);
    const lines = written();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].event).toMatchObject({
      event: "pdf.session", outcome: "success", path: "out/main.pdf", file_bytes: 100,
      range_requests: 2, bytes_read: 100, browser_hosted: false,
    });
    expect(lines[0].event.first_range_ms).toEqual(expect.any(Number));
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats a PDF rewritten by a rebuild as routine, and any other failed read as an error with a fix", async () => {
    invoke.mockRejectedValueOnce("This PDF changed on disk.");
    const { projectPdfTransport } = await import("./project-pdf");
    const stale = projectPdfTransport(file, vi.fn());
    stale.requestDataRange(0, 10);
    await settle();
    stale.abort();

    invoke.mockRejectedValueOnce(new Error("Permission denied\nsecond line"));
    const onError = vi.fn();
    const broken = projectPdfTransport(file, onError);
    broken.requestDataRange(0, 10);
    await settle();
    broken.abort();
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    const [routine, failed] = written().sort((a, b) => (a.level === "info" ? -1 : b.level === "info" ? 1 : 0));
    expect(routine).toMatchObject({ level: "info", event: { outcome: "success", stale: true, failed_reads: 1 } });
    expect(routine.event.error_kind).toBeUndefined();
    expect(failed).toMatchObject({
      level: "warn",
      event: { outcome: "error", failed_reads: 1, error_kind: "range_read_failed", error_cause: "Permission denied" },
    });
    expect(failed.event.error_fix).toEqual(expect.any(String));
  });
});
