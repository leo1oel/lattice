import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BibEntryDialog, type ResolvedCitationDraft } from "./bib-entry-dialog";

afterEach(cleanup);

function resolved(overrides: Partial<ResolvedCitationDraft> = {}): ResolvedCitationDraft {
  return {
    key: "smith2026paper",
    title: "The Paper",
    author: "Smith, Ada",
    year: "2026",
    journal: "Journal of Tests",
    booktitle: "",
    publisher: "",
    url: "https://example.test/paper",
    doi: "10.1/test",
    entryType: "article",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderDialog(onResolve: (query: string) => Promise<ResolvedCitationDraft | null>, onSave = vi.fn()) {
  render(<BibEntryDialog
    open
    busy={false}
    error={null}
    onClose={vi.fn()}
    onResolve={onResolve}
    onSave={onSave}
  />);
  return onSave;
}

describe("BibEntryDialog citation resolution", () => {
  it("requires an ambiguous candidate selection and saves it locally with extras", async () => {
    const candidate = resolved({
      evidence: { source: "Crossref", title_match: "exact" },
      extraFields: { eprint: "2601.01234", pages: "1--10" },
    });
    const onResolve = vi.fn().mockResolvedValue(resolved({
      key: "", title: "", author: "", year: "", journal: "", booktitle: "",
      publisher: "", url: "", doi: "", entryType: "", candidates: [candidate],
    }));
    const onSave = renderDialog(onResolve);

    fireEvent.change(screen.getByLabelText("Citation resolve query"), { target: { value: "paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("The Paper")).toBeInTheDocument();
    expect(screen.getByText(/Source:/)).toHaveTextContent("Crossref");
    expect(screen.getByText("Authors unchecked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save entry" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Select this record" }));
    expect(screen.getByLabelText("Title")).toHaveValue("The Paper");
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      title: "The Paper",
      extraFields: { eprint: "2601.01234", pages: "1--10" },
    }), true);
  });

  it("ignores a resolution result after the query changes", async () => {
    const pending = deferred<ResolvedCitationDraft | null>();
    renderDialog(vi.fn(() => pending.promise));
    const query = screen.getByLabelText("Citation resolve query");

    fireEvent.change(query, { target: { value: "old query" } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    fireEvent.change(query, { target: { value: "new query" } });
    pending.resolve(resolved({ title: "Stale result" }));

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(""));
    expect(screen.queryByDisplayValue("Stale result")).not.toBeInTheDocument();
  });

  it("deduplicates in-flight clicks and marks retrieved fields as edited", async () => {
    const pending = deferred<ResolvedCitationDraft | null>();
    const onResolve = vi.fn(() => pending.promise);
    renderDialog(onResolve);
    fireEvent.change(screen.getByLabelText("Citation resolve query"), { target: { value: "paper" } });
    const button = screen.getByRole("button", { name: "Resolve" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Save entry" })).toBeDisabled();
    pending.resolve(resolved({ evidence: { source: "crossref", author_match: "matched" } }));
    await screen.findByText("Compatible author names");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited title" } });
    expect(screen.getByText(/you have edited its fields/)).toBeInTheDocument();
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
});
