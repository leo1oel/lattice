import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootErrorBoundary } from "../telemetry/root-error-boundary";
import { AddPapersSheet } from "./add-papers-sheet";
import type { ResolvedCitationDraft } from "./bib-entry-dialog";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const LINK = "https://arxiv.org/abs/2312.00752";
const TITLE = "Mamba: Linear-Time Sequence Modeling with Selective State Spaces";

// What `resolve_citation_query` answers for LINK (models.rs ResolvedCitation, as serialized).
const RECORD = {
  key: "gu2023mamba", title: `{${TITLE}}`, author: "Gu, Albert and Dao, Tri", year: "2023",
  journal: "", booktitle: "", publisher: "", url: LINK, doi: "", entryType: "misc",
  bibtex: `@misc{gu2023mamba,\n  eprint = {2312.00752},\n  title = {{${TITLE}}},\n  url = {${LINK}},\n  year = {2023},\n}\n`,
  candidates: [],
  extraFields: { archiveprefix: "arXiv", eprint: "2312.00752", howpublished: "arXiv preprint arXiv:2312.00752" },
} satisfies ResolvedCitationDraft;

/** Paste `text` into a sheet inside the window's own crash boundary, and let the lookup answer. */
async function paste(text: string, onResolve: (query: string) => Promise<unknown>) {
  invoke.mockResolvedValue(undefined);
  render(
    <RootErrorBoundary>
      <AddPapersSheet
        seed="" papers={[]} importing={false}
        onResolve={onResolve as (query: string) => Promise<ResolvedCitationDraft>}
        onAdd={vi.fn()} onStop={vi.fn()} onEnterManually={vi.fn()} onLinkLibrary={vi.fn()} onClose={vi.fn()}
      />
    </RootErrorBoundary>,
  );
  vi.useFakeTimers();
  fireEvent.change(screen.getByRole("textbox", { name: "Paste references" }), { target: { value: text } });
  // The box is read once typing pauses.
  await act(async () => { vi.advanceTimersByTime(500); });
  vi.useRealTimers();
  await act(async () => { await Promise.resolve(); });
}

const stateOf = (tone: string) => document.querySelector(`.add-papers-state[data-tone="${tone}"]`);

describe("AddPapersSheet lookups", () => {
  it("shows the record a pasted arXiv link resolves to as a new paper", async () => {
    const onResolve = vi.fn().mockResolvedValue(RECORD);
    await paste(LINK, onResolve);
    expect(onResolve).toHaveBeenCalledWith(LINK);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(stateOf("new")).toHaveTextContent("New");
    expect(screen.getByRole("button", { name: /^Add/ })).toBeEnabled();
  });

  it.each([null, undefined, "gu2023mamba"])("reads a lookup answer that is not a record (%s) as not found", async (answer) => {
    // Regression: the mock backend answers unmodelled commands with null, and
    // the rows read `null.candidates` while rendering, which replaced the whole
    // window with "Lattice couldn’t open this window".
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await paste(LINK, vi.fn().mockResolvedValue(answer));
    expect(await screen.findByText("Couldn't find this one")).toBeInTheDocument();
    expect(stateOf("failed")).toHaveAttribute("title", "The lookup returned no record.");
    expect(screen.queryByRole("alert", { name: "Lattice couldn’t open this window" })).not.toBeInTheDocument();
  });

  it("shows a failed lookup's reason on its card", async () => {
    await paste(LINK, vi.fn().mockRejectedValue("HTTP status client error (404 Not Found)"));
    expect(await screen.findByText("Couldn't find this one")).toBeInTheDocument();
    expect(stateOf("failed")?.getAttribute("title")).toContain("404 Not Found");
  });
});
