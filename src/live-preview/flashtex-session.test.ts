import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { FlashtexSession } from "./flashtex-session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Report = { status: string; mode: string; pdf: boolean };
let compiled: string[];
let synced: string[][];
let report: Report;
let gate: Promise<void> | null;
let release: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  compiled = [];
  synced = [];
  report = { status: "ok", mode: "incremental", pdf: true };
  gate = null;
  vi.mocked(invoke).mockReset().mockImplementation(async (command: string, args?: unknown) => {
    const payload = args as { buffers?: { text: string }[]; paths?: string[] };
    if (command === "flashtex_preview_compile") {
      compiled.push(payload.buffers?.map((buffer) => buffer.text).join("|") ?? "");
      if (gate) await gate;
      return { pages: 1, typesetPages: 1, hostMs: 1, wallMs: 1, errors: [], ...report };
    }
    if (command === "flashtex_preview_pdf") return new ArrayBuffer(4);
    if (command === "flashtex_preview_sync") synced.push(payload.paths ?? []);
    return null;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function session() {
  const pdfs: string[] = [];
  const ended: string[] = [];
  const running = new FlashtexSession("/p", 3, "main.tex", (document) => pdfs.push(document), (reason) => ended.push(reason));
  return { running, pdfs, ended };
}

it("sends only the newest text once the compile before it answers", async () => {
  const { running, pdfs } = session();
  running.noteText("main.tex", "a");
  await vi.advanceTimersByTimeAsync(60);
  let open!: () => void;
  gate = new Promise((resolve) => { open = resolve; });
  release = open;
  running.noteText("main.tex", "ab");
  await vi.advanceTimersByTimeAsync(60);
  running.noteText("main.tex", "abc");
  running.noteText("main.tex", "abcd");
  await vi.advanceTimersByTimeAsync(60);
  gate = null;
  release();
  await vi.advanceTimersByTimeAsync(10);
  expect(compiled).toEqual(["a", "ab", "abcd"]);
  expect(pdfs).toEqual(["main.tex", "main.tex", "main.tex"]);
});

it("keeps the last good preview through a TeX error and an unchanged text", async () => {
  const { running, pdfs } = session();
  report = { status: "error", mode: "incremental", pdf: true };
  running.noteText("main.tex", "\\sec");
  await vi.advanceTimersByTimeAsync(60);
  report = { status: "ok", mode: "unchanged", pdf: true };
  running.noteText("main.tex", "\\section");
  await vi.advanceTimersByTimeAsync(60);
  expect(compiled).toHaveLength(2);
  expect(pdfs).toEqual([]);
});

it("leaves files the host does not typeset alone, and syncs the file left behind", async () => {
  const { running } = session();
  running.noteText("refs.bib", "@book{}");
  running.noteText("notes.md", "# notes");
  await vi.advanceTimersByTimeAsync(60);
  expect(compiled).toEqual([]);
  running.noteText("intro.tex", "intro");
  await vi.advanceTimersByTimeAsync(60);
  running.noteText("main.tex", "main");
  await vi.advanceTimersByTimeAsync(60);
  expect(synced).toEqual([["intro.tex"]]);
  expect(compiled).toEqual(["intro", "main"]);
});

it("ends quietly when the host stops answering", async () => {
  const { running, pdfs, ended } = session();
  vi.mocked(invoke).mockRejectedValue(new Error("FlashTeX has stopped."));
  running.noteText("main.tex", "a");
  await vi.advanceTimersByTimeAsync(60);
  running.noteText("main.tex", "ab");
  await vi.advanceTimersByTimeAsync(60);
  expect(ended).toEqual(["FlashTeX has stopped."]);
  expect(pdfs).toEqual([]);
});
