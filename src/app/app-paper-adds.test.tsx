import { fileNode, fileNodes, refreshableProject, projectSnapshot, MAIN_DOCUMENT, deferred, setInterfaceLanguage, expectNotification, expectInvoked, invokeCalls } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { renderApp } = appHarness({ documentCanvas });

describe("adding papers from the Papers box", () => {
  it.each([false, true])("downloads the resolved title snapshot without a second search (ambiguous: %s)", async (ambiguous) => {
    const title = "An Unambiguous Research Report";
    const bibtex = "@misc{report2026, title={An Unambiguous Research Report}, author={Ada Smith}, year={2026}, eprint={2601.01234}, archivePrefix={arXiv}}";
    const draft = { key: "report2026", title, author: "Ada Smith", year: "2026", journal: "", booktitle: "", publisher: "", url: "https://arxiv.org/abs/2601.01234", doi: "", entryType: "misc", bibtex, extraFields: { eprint: "2601.01234", archivePrefix: "arXiv" } };
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-title-import", projectId: "title-import", name: "Title import", rootDocuments: [], trusted: true, files: [],
    });
    let imported = false;
    renderApp({
      ...refreshableProject(snapshot, ""),
      list_papers: () => imported
        ? [{ arxivId: "2601.01234", title, hasFullText: true, hasBlog: true, citationKey: draft.key }] : [],
      resolve_citation_query: () => ambiguous
        ? { candidates: [{ ...draft, key: "other", year: "2025", extraFields: { eprint: "2501.05678" } }, draft] }
        : draft,
      import_reference: () => {
        imported = true;
        return { arxivId: "2601.01234", title, citationKey: draft.key, alreadyImported: false, paperPath: ".research/papers/2601.01234/paper.md" };
      },
    });
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search or import papers" }), { target: { value: title } });
    fireEvent.click(screen.getByRole("button", { name: /^Look up and add/ }));
    if (ambiguous) {
      await screen.findByRole("radiogroup", { name: "Citation candidates" });
      expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
      fireEvent.click(screen.getAllByRole("radio")[1]);
      fireEvent.click(screen.getByRole("button", { name: "Use this record" }));
      fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    }
    await expectInvoked("import_reference", {
      input: ambiguous ? expect.stringContaining("eprint = {2601.01234}") : bibtex, requestId: expect.any(String),
      // Adding cites alone unless the writer turned on saving full text.
      fullText: false,
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument());
    expect(invokeCalls("resolve_citation_query")).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", expect.anything());
  });

  it.each([false, true])("reviews title candidates without importing and opens DOI-only sources externally (cancel: %s)", async (cancelled) => {
    const title = "Visual object processing in optic aphasia: A case of semantic access agnosia";
    const doi = "10.1093/neucas/3.3.209-w";
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-title-review", projectId: "title-review", name: "Title review", rootDocuments: [], trusted: true, files: [],
    });
    const draft = { key: "riddoch1997visual", title, author: "Riddoch, M. J.", year: "1997", journal: "Neurocase", booktitle: "", publisher: "", url: `https://doi.org/${doi}`, doi, entryType: "article" };
    const resolution = deferred<unknown>();
    renderApp({
      initial_project: snapshot, refresh_project: snapshot, list_history: () => [],
      list_papers: () => [{ ...draft, arxivId: "", citationKey: draft.key, hasFullText: false, hasBlog: false }],
      resolve_citation_query: () => resolution.promise, cancel_reference_import: false,
    });
    fireEvent.click(await screen.findByTitle("Open source page — no downloadable full text found"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(draft.url));
    expect(invoke).not.toHaveBeenCalledWith("fetch_web_reference", expect.anything());
    const box = screen.getByRole("searchbox", { name: "Search or import papers" });
    // A title the library does not hold (the year differs): Enter only
    // searches, and its add row explicitly resolves a new import.
    const query = `${title} 1987`;
    fireEvent.change(box, { target: { value: query } });
    fireEvent.click(screen.getByRole("button", { name: /^Look up and add/ }));
    await expectInvoked("resolve_citation_query", { query });
    if (cancelled) fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const alternative = { ...draft, year: "1987", journal: "Cognitive Neuropsychology", doi: "10.1080/02643298708252038" };
    await act(async () => { resolution.resolve({ ...draft, candidates: [draft, alternative] }); });
    if (cancelled) {
      expect(screen.queryByRole("radiogroup", { name: "Citation candidates" })).not.toBeInTheDocument();
    } else {
      expect(await screen.findByRole("radiogroup", { name: "Citation candidates" })).toHaveTextContent("Cognitive Neuropsychology");
      // Nothing can be saved until a candidate is chosen or the entry is typed by hand.
      expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enter manually" })).toBeInTheDocument();
    }
    expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", expect.anything());
  });

  it.each(["save", "dismiss"] as const)("lets a manual entry %s while its abandoned lookup is still running", async (finish) => {
    // Regression: Enter manually abandoned the lookup only inside the dialog;
    // App still held it as resolving, so Save and Cancel did nothing until the
    // backend answered, and a late failure was reported into the next dialog.
    const lookup = deferred<unknown>();
    renderApp({
      ...refreshableProject(projectSnapshot({ trusted: true, files: fileNodes("main.tex", "references.bib") })),
      resolve_citation_query: () => lookup.promise,
      write_project_file: (args) => ({ content: (args as { content: string }).content, hadConflicts: false }),
    });
    // The palette is a project command; wait for the project before invoking it.
    await screen.findByRole("button", { name: "Switch project" });
    // Add papers, then one entry by hand: the form, with its lookup above it.
    const openDialog = async () => {
      fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
      const palette = await screen.findByRole("searchbox", { name: "Command palette" });
      fireEvent.change(palette, { target: { value: "Add papers" } });
      fireEvent.keyDown(palette, { key: "Enter" });
      fireEvent.click(await screen.findByRole("button", { name: "Enter manually" }));
      return screen.findByLabelText("Citation resolve query");
    };
    const query = await openDialog();
    fireEvent.change(query, { target: { value: "10.1/slow" } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await expectInvoked("resolve_citation_query", { query: "10.1/slow" });

    // A new query abandons the lookup still running.
    fireEvent.change(query, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Typed by hand" } });
    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "Doe, Jane" } });
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2025" } });
    fireEvent.click(screen.getByLabelText("Insert cite at cursor after saving"));
    if (finish === "save") {
      fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
      await expectInvoked("write_project_file", expect.objectContaining({ content: expect.stringContaining("Typed by hand") }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    }
    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());

    // The next entry starts clean, and the old lookup's failure stays out of it.
    await openDialog();
    await act(async () => {
      lookup.reject(new Error("bibcite timed out"));
      await lookup.promise.catch(() => undefined);
    });
    expect(screen.queryByText(/bibcite timed out/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Citation resolve query"), { target: { value: "10.1/next" } });
    expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled();
  });

  it("adds a work with no preprint through the same box, and settles it as just added", async () => {
    const snapshot = projectSnapshot({ rootDocuments: MAIN_DOCUMENT, trusted: true, files: [fileNode("main.tex", "file")] });
    const title = "Deep Residual Learning for Image Recognition";
    let imported = false;
    renderApp({
      ...refreshableProject(snapshot),
      list_papers: () => imported
        ? [{ arxivId: "", title, citationKey: "he2016deep", doi: "10.1109/CVPR.2016.90", hasFullText: false, hasBlog: false }] : [],
      bibliography_audit_scan: () => ({ entries: [], issues: [] }),
      // No arXiv id anywhere in the answer: bibcite resolved a DOI and wrote
      // the entry, and there is no text on disk to point at.
      import_reference: () => {
        imported = true;
        return { paperPath: "", arxivId: "", title, citationKey: "he2016deep", citationOutput: "", alreadyImported: false };
      },
    });
    const box = await screen.findByPlaceholderText("Search or add papers");
    fireEvent.change(box, { target: { value: "10.1109/CVPR.2016.90" } });
    // Enter adds an identifier, as the add row under the box says.
    fireEvent.keyDown(box, { key: "Enter" });

    await expectInvoked("import_reference", { input: "10.1109/CVPR.2016.90", requestId: expect.any(String), fullText: false });
    expect(box).toHaveValue("10.1109/CVPR.2016.90");
    // No toast: the row settles as just added, a citation with no full text
    // to open, its key out to copy.
    const row = (await screen.findByText(title, { selector: ".paper-row .paper-title" })).closest<HTMLElement>(".paper-row")!;
    expect(row).toHaveClass("just-added");
    expect(row).toHaveAttribute("data-reading", "citation");
    expect(within(row).getByRole("button", { name: "Copy citation key he2016deep" })).toBeInTheDocument();
    const checkReferences = screen.getByRole("button", { name: "Check references" });
    expect(checkReferences.closest(".trellis-accessory-host")).toBeInTheDocument();
    expect(checkReferences.textContent).toBe("");
    fireEvent.click(checkReferences);
    await expectInvoked("bibliography_audit_scan", { projectRoot: snapshot.root });
  });

  it.each([
    [false, false, "en"], [true, false, "en"],
    [false, false, "zh-CN"], [true, false, "zh-CN"],
    [false, true, "zh-CN"], [true, true, "zh-CN"],
  ] as const)("cancels the active import with its request id (bibliography: %s, full text: %s, locale: %s)", async (committed, fullText, locale) => {
    await setInterfaceLanguage(locale);
    const snapshot = projectSnapshot({ rootDocuments: MAIN_DOCUMENT, trusted: true, files: [] });
    const importing = deferred<unknown>();
    let requestId: string | undefined;
    renderApp({
      initial_project: snapshot, refresh_project: snapshot, list_papers: () => [], list_history: () => [],
      import_reference: (args) => {
        requestId = (args as { requestId: string }).requestId;
        return importing.promise;
      },
      cancel_reference_import: true,
    });
    fireEvent.click(await screen.findByRole("tab", { name: /^(Papers|论文库)$/ }));
    const box = await screen.findByRole("searchbox", { name: /^(Search or import papers|搜索或导入论文)$/ });
    fireEvent.change(box, { target: { value: "10.1080/02643298708252038" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const cancel = await screen.findByRole("button", { name: /^(Cancel|取消)$/ });
    expect(requestId).toBeTruthy();
    fireEvent.click(cancel);
    await expectInvoked("cancel_reference_import", { requestId });
    // Do not claim cancellation finished while the backend is still stopping.
    expect(document.querySelector(".paper-pending")).not.toBeNull();
    await act(async () => importing.resolve({
      arxivId: "", title: "A new paper", paperPath: fullText ? ".research/papers/new/paper.md" : "", alreadyImported: false,
      cancelled: true, citationKey: committed ? "new2026" : undefined,
    }));
    await waitFor(() => expect(document.querySelector(".paper-pending")).toBeNull());
    if (locale === "en") {
      await expectNotification(committed ? /remains in the bibliography.*\\cite\{new2026\}/ : /cancelled before making changes/);
    } else {
      await expectNotification(committed
        ? fullText
          ? /取消前“A new paper”已导入完成，用 \\cite\{new2026\} 引用/
          : /已取消导入。“A new paper”仍在文献中，用 \\cite\{new2026\} 引用；不再获取全文/
        : fullText
          ? /已取消导入，文献未改动；下好的全文仍可用/
          : /已取消导入，没有改动/);
    }
    expect(box).toHaveValue("10.1080/02643298708252038");
  });
});
