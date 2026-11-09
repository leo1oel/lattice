import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LATTICE_HOST_FILE_WRITES,
  noteHostFileWrites,
  setHostFileWritesSink,
  type HostFileWritesMessage,
} from "./agent-host-writes";

describe("host file writes for the agent panel", () => {
  let sent: HostFileWritesMessage[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T10:00:00.000Z"));
    sent = [];
  });
  const collect = (message: HostFileWritesMessage) => {
    sent.push(message);
    return true;
  };
  afterEach(() => {
    setHostFileWritesSink(null);
    vi.useRealTimers();
  });

  it("coalesces a burst into one message per project, with each path's write time", () => {
    setHostFileWritesSink(collect);
    noteHostFileWrites("/paper", ["main.tex"]);
    vi.advanceTimersByTime(100);
    noteHostFileWrites("/paper", ["main.tex", "sec/intro.tex"]);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{
      type: LATTICE_HOST_FILE_WRITES,
      version: 1,
      workspaceRoot: "/paper",
      writes: [
        { path: "main.tex", writtenAt: "2026-11-08T10:00:00.100Z" },
        { path: "sec/intro.tex", writtenAt: "2026-11-08T10:00:00.100Z" },
      ],
    }]);
  });

  it("drops paths that are not inside the project", () => {
    setHostFileWritesSink(collect);
    noteHostFileWrites("/paper", ["/etc/passwd", "../other/main.tex", "a/../b.tex"]);
    noteHostFileWrites(null, ["main.tex"]);
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual([]);
  });

  it("keeps recent writes until a panel frame is ready, and lets old ones go", () => {
    noteHostFileWrites("/paper", ["old.tex"]);
    vi.advanceTimersByTime(121_000);
    noteHostFileWrites("/paper", ["main.tex"]);
    setHostFileWritesSink(collect);
    vi.advanceTimersByTime(250);
    expect(sent.flatMap((message) => message.writes.map((write) => write.path))).toEqual(["main.tex"]);
  });

  it("splits a large sync across several messages", () => {
    setHostFileWritesSink(collect);
    noteHostFileWrites("/paper", Array.from({ length: 450 }, (_, index) => `f${index}.tex`));
    vi.advanceTimersByTime(250);
    expect(sent.map((message) => message.writes.length)).toEqual([200, 200, 50]);
  });

  it("keeps a project's writes that the ready panel refused for that project's next panel", () => {
    // The open panel belongs to /other; /paper's writes wait for /paper's panel.
    setHostFileWritesSink((message) => message.workspaceRoot === "/other" && collect(message));
    noteHostFileWrites("/paper", ["main.tex"]);
    noteHostFileWrites("/other", ["notes.tex"]);
    vi.advanceTimersByTime(250);
    expect(sent.map((message) => message.workspaceRoot)).toEqual(["/other"]);
    setHostFileWritesSink(collect);
    vi.advanceTimersByTime(250);
    expect(sent.map((message) => message.workspaceRoot)).toEqual(["/other", "/paper"]);
  });
});
