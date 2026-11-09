import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { notifySuccess } from "../telemetry/app-notify";
import { LiteratureDiscoveryPanel } from "./literature-discovery-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../telemetry/app-notify", () => ({ notifySuccess: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(notifySuccess).mockReset();
});

const hit = (arxivId: string, title: string) => ({ source: "alphaxiv", arxivId, title, authors: ["Lee"], year: 2026 });

async function openWithResults(onImportArxiv: (arxivId: string) => Promise<boolean>) {
  vi.mocked(invoke).mockResolvedValue({ hits: [hit("2601.00001", "Sparse Attention"), hit("2601.00002", "Dense Retrieval")], hasMore: false });
  render(<LiteratureDiscoveryPanel initialQuery="attention" onClose={vi.fn()} onImportArxiv={onImportArxiv} onAddBib={vi.fn()} importedIds={new Set()} />);
  return {
    first: await screen.findByRole("button", { name: "Add Sparse Attention to Papers" }),
    second: screen.getByRole("button", { name: "Add Dense Retrieval to Papers" }),
  };
}

describe("adding a result to Papers", () => {
  it("says nothing was imported when the import added nothing", async () => {
    const { first } = await openWithResults(async () => false);
    await act(async () => { fireEvent.click(first); });
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(screen.queryByText("In Papers")).toBeNull();
  });

  it("holds every other result's Add while one imports", async () => {
    let finish!: (imported: boolean) => void;
    const onImport = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { first, second } = await openWithResults(onImport);
    fireEvent.click(first);
    expect(second).toBeDisabled();
    fireEvent.click(second);
    expect(onImport).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); });
    expect(notifySuccess).toHaveBeenCalledWith(expect.anything(), "Imported arXiv:2601.00001");
    expect(second).toBeEnabled();
  });
});
