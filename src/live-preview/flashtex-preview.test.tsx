import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { onFlashtexPdf, useFlashtexPreview } from "./flashtex-preview";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

let install: { supported: boolean; installed: boolean; unicode: boolean; version: string };

function open(engine: string) {
  const project = {
    root: "/papers/pdf",
    files: [],
    manifest: { engine, rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }] },
  } as unknown as ProjectSnapshot;
  return renderHook(() => useFlashtexPreview({ project, activeFile: "main.tex", source: "\\documentclass{article}" }));
}

const commands = () => vi.mocked(invoke).mock.calls.map(([command]) => command);

beforeEach(() => {
  localStorage.clear();
  install = { supported: true, installed: true, unicode: false, version: "0.2.0" };
  vi.mocked(invoke).mockReset().mockImplementation(async (command: string) => {
    if (command === "flashtex_preview_status") return install;
    if (command === "flashtex_preview_start") return 4;
    if (command === "flashtex_preview_compile") return { status: "ok", mode: "incremental", pdf: true, errors: [] };
    if (command === "flashtex_preview_pdf") return new ArrayBuffer(8);
    return null;
  });
});
afterEach(() => {
  localStorage.clear();
});

it("does nothing at all without the developer flag", async () => {
  const { unmount } = open("pdflatex");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(commands()).toEqual([]);
  unmount();
});

it("previews a pdfLaTeX project's unsaved text with the flag on, and stops with the project", async () => {
  localStorage.setItem("lattice.dev.flashtex-preview", "1");
  const pdfs: string[] = [];
  const stop = onFlashtexPdf("/papers/pdf", (document) => pdfs.push(document));
  const { unmount } = open("pdflatex");
  await waitFor(() => expect(pdfs).toEqual(["main.tex"]));
  expect(commands().slice(0, 2)).toEqual(["flashtex_preview_status", "flashtex_preview_start"]);
  expect(vi.mocked(invoke).mock.calls.find(([command]) => command === "flashtex_preview_start")?.[1])
    .toMatchObject({ projectRoot: "/papers/pdf", mainFile: "main.tex", engine: "pdflatex" });
  unmount();
  expect(commands()).toContain("flashtex_preview_stop");
  stop();
});

it("leaves a XeLaTeX project alone without a XeTeX host, and other engines always", async () => {
  localStorage.setItem("lattice.dev.flashtex-preview", "1");
  open("xelatex");
  await waitFor(() => expect(commands()).toEqual(["flashtex_preview_status"]));
  vi.mocked(invoke).mockClear();
  open("lualatex");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(commands()).toEqual([]);
});
