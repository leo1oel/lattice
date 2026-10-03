import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BibEntryDialog, type ResolvedCitationDraft } from "./bib-entry-dialog";
import { appendBibEntry, formatBibEntry } from "./bib-entry";

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

function renderDialog(props: Partial<ComponentProps<typeof BibEntryDialog>> = {}) {
  const onSave = vi.fn();
  render(<BibEntryDialog open busy={false} error={null} onClose={vi.fn()} onSave={onSave} {...props} />);
  return onSave;
}

function resolveQuery(value: string) {
  fireEvent.change(screen.getByLabelText("Citation resolve query"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
}

describe("BibEntryDialog citation resolution", () => {
  it("retains title and corporate author braces when editing and saving", () => {
    const onSave = renderDialog({
      mode: "edit",
      initialDraft: resolved({ title: "{Gemma: Open AI Models}", author: "{Gemma Team} and Jane Doe" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const bibtex = formatBibEntry(onSave.mock.calls[0][0]);
    expect(bibtex).toContain("title = {{Gemma: Open AI Models}}");
    expect(bibtex).toContain("author = {{Gemma Team} and Jane Doe}");
  });

  it("shows both same-title records supplied by Papers before allowing a save", () => {
    const title = "Visual object processing in optic aphasia: A case of semantic access agnosia";
    const candidates = [
      resolved({ title, year: "1997", journal: "Neurocase", doi: "10.1093/neucas/3.3.209-w" }),
      resolved({ title, year: "1987", journal: "Cognitive Neuropsychology", doi: "10.1080/02643298708252038" }),
    ];
    const onSave = renderDialog({ initialDraft: resolved({ candidates }) });
    expect(screen.getByRole("button", { name: "Save entry" })).toBeDisabled();
    expect(screen.getByText("Neurocase")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Select this record" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ year: "1987", doi: "10.1080/02643298708252038" }), true);
  });

  it("keeps the draft visible and reports duplicate keys without writing", () => {
    const write = vi.fn();
    function Harness() {
      const [error, setError] = useState<string | null>(null);
      return <BibEntryDialog open busy={false} error={error} initialDraft={resolved()}
        onClose={vi.fn()} onSave={(draft) => {
          try {
            write(appendBibEntry("@book{smith2026paper,title={A Different Work}}", formatBibEntry(draft)));
          } catch (reason) {
            setError((reason as Error).message);
          }
        }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByLabelText("Title")).toHaveValue("The Paper");
    expect(write).not.toHaveBeenCalled();
  });

  it("requires an ambiguous candidate selection and saves it locally with extras", async () => {
    const candidate = resolved({
      evidence: { source: "Crossref", title_match: "exact" },
      extraFields: { eprint: "2601.01234", pages: "1--10" },
    });
    const onResolve = vi.fn().mockResolvedValue(resolved({
      key: "", title: "", author: "", year: "", journal: "", booktitle: "",
      publisher: "", url: "", doi: "", entryType: "", candidates: [candidate],
    }));
    const onSave = renderDialog({ onResolve });
    resolveQuery("paper");
    expect(await screen.findByText("The Paper")).toBeInTheDocument();
    expect(screen.getByText(/Source:/)).toHaveTextContent("Crossref");
    expect(screen.getByText("Authors unchecked")).toBeInTheDocument();
    // Nothing to save until a record is chosen.
    expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument();
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
    renderDialog({ onResolve: vi.fn(() => pending.promise) });
    resolveQuery("old query");
    fireEvent.change(screen.getByLabelText("Citation resolve query"), { target: { value: "new query" } });
    pending.resolve(resolved({ title: "Stale result" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled());
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Stale result")).not.toBeInTheDocument();
  });

  it("deduplicates in-flight clicks and marks retrieved fields as edited", async () => {
    const pending = deferred<ResolvedCitationDraft | null>();
    const onResolve = vi.fn(() => pending.promise);
    renderDialog({ onResolve });
    const button = screen.getByRole("button", { name: "Resolve" });
    resolveQuery("paper");
    fireEvent.click(button);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument();
    pending.resolve(resolved({ evidence: { source: "crossref", author_match: "matched" } }));
    await screen.findByText("Compatible author names");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited title" } });
    expect(screen.getByText(/you have edited its fields/)).toBeInTheDocument();
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
});

describe("BibEntryDialog entry paths", () => {
  it("leads a new entry with the lookup and keeps the fields one step away", () => {
    renderDialog({ onResolve: vi.fn() });
    expect(screen.getByLabelText("Citation resolve query")).toHaveFocus();
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
    expect(screen.getByLabelText("Title")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save entry" })).toBeDisabled();
  });

  it("carries what the lookup query says into the manual form", () => {
    for (const [query, field, value] of [
      ["https://doi.org/10.1038/nphys1170", "DOI", "10.1038/nphys1170"],
      ["https://example.test/paper", "URL", "https://example.test/paper"],
      ["A Paper Worth Citing", "Title", "A Paper Worth Citing"],
      ["arXiv:1706.03762", "URL", "https://arxiv.org/abs/1706.03762"],
      ["10.1038/nphys1170 extra words", "Title", "10.1038/nphys1170 extra words"],
      ["10.1038/nphys1170 extra words", "DOI", ""],
      ["https://example.test/paper and more", "URL", ""],
    ] as const) {
      renderDialog({ onResolve: vi.fn() });
      fireEvent.change(screen.getByLabelText("Citation resolve query"), { target: { value: query } });
      fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
      expect(screen.getByLabelText(field)).toHaveValue(value);
      cleanup();
    }
  });

  it("never carries the query over a field that already holds a value", () => {
    renderDialog({
      onResolve: vi.fn(),
      initialResolveQuery: "A Different Title",
      initialDraft: resolved({ title: "Seeded Title", candidates: [resolved(), resolved({ year: "1999" })] }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Seeded Title");
  });

  it("declines candidates found after manual entry and keeps the typed fields", async () => {
    const onResolve = vi.fn(async () => resolved({ candidates: [resolved(), resolved({ year: "1999" })] }));
    const onSave = renderDialog({ onResolve });
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Own Title" } });
    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "Doe, Jane" } });
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    resolveQuery("ambiguous title");
    await screen.findAllByRole("button", { name: "Select this record" });
    expect(screen.getByRole("button", { name: "Save entry" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my fields" }));
    expect(screen.queryByRole("button", { name: "Select this record" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Own Title");
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: "Own Title", author: "Doe, Jane", year: "2025" }), true);
  });

  it("keeps a retrieved record whole when its fields are kept over later candidates", async () => {
    const onResolve = vi.fn()
      .mockResolvedValueOnce(resolved({ evidence: { source: "crossref", author_match: "matched" }, extraFields: { pages: "1--10" } }))
      .mockResolvedValueOnce(resolved({ candidates: [resolved({ title: "Other" }), resolved({ year: "1999" })] }));
    const onSave = renderDialog({ onResolve });
    resolveQuery("10.1/test");
    await screen.findByText("Compatible author names");
    resolveQuery("ambiguous title");
    await screen.findAllByRole("button", { name: "Select this record" });
    fireEvent.click(screen.getByRole("button", { name: "Keep my fields" }));
    expect(screen.getByText("Compatible author names")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: "The Paper", extraFields: { pages: "1--10" } }), true);
  });

  it("enters manually past ambiguous candidates without saving any of them", () => {
    const onSave = renderDialog({
      onResolve: vi.fn(),
      initialDraft: resolved({ key: "", title: "", author: "", year: "", journal: "", doi: "", url: "", candidates: [resolved(), resolved({ year: "1999" })] }),
    });
    expect(screen.getAllByRole("button", { name: "Select this record" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
    expect(screen.queryByRole("button", { name: "Select this record" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
    const save = screen.getByRole("button", { name: "Save entry" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Own Title" } });
    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "Doe, Jane" } });
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: "Own Title", doi: undefined }), true);
  });

  it("drops a lookup still running once the writer enters the entry by hand", async () => {
    const pending = deferred<ResolvedCitationDraft | null>();
    renderDialog({ onResolve: vi.fn(() => pending.promise) });
    resolveQuery("10.1/late");
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Typed by hand" } });
    pending.resolve(resolved({ title: "Late record" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled());
    expect(screen.getByLabelText("Title")).toHaveValue("Typed by hand");
  });

  it("shows a failed lookup beside the lookup, with the manual path still there", () => {
    renderDialog({ onResolve: vi.fn(), error: "bibcite could not resolve that query." });
    expect(screen.getByRole("alert")).toHaveTextContent("could not resolve");
    expect(screen.getByRole("button", { name: "Enter manually" })).toBeInTheDocument();
  });

  it("keeps the BibTeX preview behind a disclosure that still reads the draft", () => {
    renderDialog({ mode: "edit", initialDraft: resolved() });
    const preview = screen.getByLabelText("BibTeX preview", { selector: "pre" });
    expect(preview.closest("details")).not.toHaveAttribute("open");
    expect(preview).toHaveTextContent("title = {The Paper}");
    fireEvent.click(screen.getByText("BibTeX preview", { selector: "summary" }));
    expect(preview.closest("details")).toHaveAttribute("open");
  });
});
