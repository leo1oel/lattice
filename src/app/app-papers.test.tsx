import { synaraHook, openTreeFile, waitForSelectedTab, fileNode, fileNodes, dirNode, type Commands, mockCommands, projectCommands, refreshableProject, SINGLE_TRANSFORMER, attentionPaper, ROOT, projectSnapshot, MAIN_DOCUMENT, markdownSnapshot, PAPER_ABSTRACT, readPathContent, deferred, setAutoBuildMode, setInterfaceLanguage, papersList, openPaper, findProjectTreeItem, renderApp, expectNotification, findElement, findEditorView, expectEditorText, postWindowMessage, expectInvoked, invokeCalls, persistLayout, paneContent, visualEditorOf, argPath, openAgentFrame, postedOfType, pdfDocumentStub, mockPdfDocument, emitTauriEvent } from "./app-test-utils";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { NodeSelection } from "@tiptap/pm/state";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist";
import { describe, expect, it, vi } from "vitest";
import { loadVisualMarkdownEditorModule } from "../canvas/canvas-lazy-modules";

describe("papers", () => {
  it("lists a work that is only cited but does not offer to open it", async () => {
    const paperFetch = deferred<unknown>();
    renderApp({
      // Importing refreshes the project afterwards.
      ...refreshableProject(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        attentionPaper(),
        // Added through bibcite: in the bibliography, never fetched.
        { arxivId: "1412.6980", title: "Adam: A Method for Stochastic Optimization", citationKey: "kingma2015adam", hasFullText: false },
        // A book: cited, but there is no preprint to fetch.
        { arxivId: "", title: "The TeXbook", citationKey: "knuth1984texbook", hasFullText: false },
      ],
      fetch_paper: paperFetch.promise,
    });
    // Let the lazy workspace finish mounting before reading its Papers panel.
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 30_000 });
    const papers = within(await screen.findByRole("list", { name: "Papers" }));
    // Its preprint is known, so the row offers to fetch rather than going dead.
    const citedOnly = await papers.findByTitle("Download arXiv 1412.6980");
    expect(citedOnly).toBeEnabled();
    expect(citedOnly.closest(".paper-row")).toHaveClass("cited-only");
    expect(citedOnly).toHaveTextContent("arXiv 1412.6980");

    // A work with no preprint has nothing to fetch, so it stays inert.
    expect(papers.getByTitle(/The TeXbook.*no local reading available/)).toBeDisabled();

    // The fetched one still opens in the reader.
    expect(papers.getByTitle("Attention Is All You Need")).toBeEnabled();

    fireEvent.click(citedOnly);
    await expectInvoked("fetch_paper", { arxivId: "1412.6980" });
    const input = screen.getByRole("searchbox", { name: "Search or import papers" });
    expect(input).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".paper-import-track")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await act(async () => {
      paperFetch.resolve({ paperPath: ".research/papers/1412.6980/paper.md", arxivId: "1412.6980", reused: false });
    });
    await waitFor(() => expect(input).toHaveAttribute("aria-busy", "false"));
    expect(document.querySelector(".paper-import-track")).toBeNull();
  }, 60_000);

  it("warns about DOI-exact citation updates and opens the Crossref notice", async () => {
    const work = { arxivId: "", hasFullText: false, hasBlog: false };
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [{
        ...work, doi: "10.1234/example", title: "A historically important result", citationKey: "example2020",
        citationHealth: {
          kind: "retracted", updateType: "retraction", source: "retraction-watch", date: "2023-09-17",
          link: "https://doi.org/10.5555/retraction-notice", checkedAt: "2026-08-13T12:00:00Z",
        },
      }, {
        ...work, doi: "10.1234/no-updates", title: "No registered update", citationKey: "current2024",
        citationHealth: { kind: "unknown", source: "crossref", checkedAt: "2026-08-13T12:00:00Z" },
      }],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Retracted · Retraction Watch · 2023-09-17");
    expect(screen.queryByText(/No Crossref update metadata found/, { selector: ".paper-citation-health" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retracted · Retraction Watch · 2023-09-17. Open notice" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://doi.org/10.5555/retraction-notice"));
  });

  it("filters the current Papers library by metadata without starting an import", async () => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        attentionPaper({ authors: "Ashish Vaswani and Noam Shazeer", citationKey: "vaswani2017attention", hasBlog: false }),
        {
          arxivId: "1412.6980", title: "Adam: A Method for Stochastic Optimization", authors: "Diederik P. Kingma and Jimmy Ba",
          citationKey: "kingma2015adam", hasFullText: true, hasBlog: false,
        },
      ],
      search_paper_library: (args) => (args as { query?: string } | undefined)?.query === "scaled dot-product" ? [{
        kind: "paper", path: ".research/papers/1706.03762/paper.md", title: "Attention Is All You Need",
        snippet: "The scaled dot-product attention mechanism.", line: 42, arxivId: "1706.03762",
      }] : [],
    });
    const search = await screen.findByRole("searchbox", { name: "Search or import papers" });
    const list = within(await screen.findByRole("list", { name: "Papers" }));
    const [attention, adam] = ["Attention Is All You Need", "Adam: A Method for Stochastic Optimization"];

    fireEvent.change(search, { target: { value: "diederik 1412" } });
    expect(list.getByTitle(adam)).toBeInTheDocument();
    expect(list.queryByTitle(attention)).not.toBeInTheDocument();
    expect(list.getByText("1 of 2 papers")).toBeInTheDocument();

    for (const query of ["https://arxiv.org/pdf/1706.03762", "vaswani attention"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(list.getByTitle(attention)).toBeInTheDocument();
      expect(list.queryByTitle(adam)).not.toBeInTheDocument();
    }

    fireEvent.change(search, { target: { value: "scaled dot-product" } });
    await waitFor(() => {
      expect(list.getByTitle(attention)).toBeInTheDocument();
      expect(list.getByText("The scaled dot-product attention mechanism.")).toBeInTheDocument();
    });
    expect(list.queryByTitle(adam)).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing paper" } });
    expect(list.getByText("No matching papers")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Add paper" }));
    if (ambiguous) {
      await screen.findByRole("region", { name: "Citation candidates" });
      expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
      fireEvent.click(screen.getAllByRole("button", { name: "Select this record" })[1]);
      fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    }
    await expectInvoked("import_reference", {
      input: ambiguous ? expect.stringContaining("eprint = {2601.01234}") : bibtex, requestId: expect.any(String),
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
    fireEvent.change(box, { target: { value: title } });
    // Enter only searches; + explicitly resolves a new import.
    fireEvent.click(screen.getByRole("button", { name: "Add paper" }));
    await expectInvoked("resolve_citation_query", { query: title });
    if (cancelled) fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const alternative = { ...draft, year: "1987", journal: "Cognitive Neuropsychology", doi: "10.1080/02643298708252038" };
    await act(async () => { resolution.resolve({ ...draft, candidates: [draft, alternative] }); });
    if (cancelled) {
      expect(screen.queryByRole("region", { name: "Citation candidates" })).not.toBeInTheDocument();
    } else {
      expect(await screen.findByRole("region", { name: "Citation candidates" })).toHaveTextContent("Cognitive Neuropsychology");
      // Nothing can be saved until a candidate is chosen or the entry is typed by hand.
      expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enter manually" })).toBeInTheDocument();
    }
    expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", expect.anything());
  });

  it("adds a work with no preprint through the same box, and says there is nothing to open", async () => {
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
    const box = await screen.findByPlaceholderText("Search or add by title, arXiv ID, DOI, or URL");
    fireEvent.change(box, { target: { value: "10.1109/CVPR.2016.90" } });
    fireEvent.click(screen.getByRole("button", { name: "Add paper" }));

    await expectInvoked("import_reference", { input: "10.1109/CVPR.2016.90", requestId: expect.any(String) });
    // The DOI must not be mistaken for an arXiv id, and the message has to
    // admit there is nothing to open rather than imply a paper was fetched.
    await expectNotification(/Added .Deep Residual Learning.*cite it with \\cite\{he2016deep\}.*No full text to open/);
    expect(box).toHaveValue("10.1109/CVPR.2016.90");
    expect(await screen.findByText(title, { selector: ".paper-open strong" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("tab", { name: /^(Papers|论文)$/ }));
    const box = await screen.findByRole("searchbox", { name: /^(Search or import papers|搜索或导入论文)$/ });
    fireEvent.change(box, { target: { value: "10.1080/02643298708252038" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Add paper|添加论文)$/ }));
    const cancel = await screen.findByRole("button", { name: /^(Cancel|取消)$/ });
    expect(requestId).toBeTruthy();
    fireEvent.click(cancel);
    await expectInvoked("cancel_reference_import", { requestId });
    // Do not claim cancellation finished while the backend is still stopping.
    expect(box).toHaveAttribute("readonly");
    await act(async () => importing.resolve({
      arxivId: "", title: "A new paper", paperPath: fullText ? ".research/papers/new/paper.md" : "", alreadyImported: false,
      cancelled: true, citationKey: committed ? "new2026" : undefined,
    }));
    await waitFor(() => expect(box).not.toHaveAttribute("readonly"));
    if (locale === "en") {
      await expectNotification(committed ? /remains in the bibliography.*\\cite\{new2026\}/ : /cancelled before making changes/);
    } else {
      await expectNotification(committed
        ? fullText
          ? /收到取消请求时，《A new paper》及其全文已导入完成。可使用 \\cite\{new2026\} 引用。/
          : /已取消导入。《A new paper》仍保留在参考文献中，可使用 \\cite\{new2026\} 引用；已停止获取全文。/
        : fullText
          ? /已取消论文导入，参考文献未修改；已下载的全文仍可使用。/
          : /已取消论文导入，未作任何修改。/);
    }
    expect(box).toHaveValue("10.1080/02643298708252038");
  });

  it.each(["click", "drop"])("shows imported papers by title while keeping the arXiv id via %s", async (interaction) => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [attentionPaper({ authors: "Ashish Vaswani and Noam Shazeer", hasBlog: true })],
      read_paper: "---\ntitle: Attention Is All You Need\nnotes: |\n  - [ ] Hidden metadata task\n---\n\n## Abstract\n\n- [ ] Review paper",
      read_paper_blog_local: "# Attention overview\n\nA concise explanation.", write_project_file: undefined,
    });
    const paper = await screen.findByRole("button", { name: /Attention Is All You Need.*1706\.03762/i });
    expect(screen.queryByRole("button", { name: "Paper lookup" })).not.toBeInTheDocument();
    if (interaction === "click") fireEvent.click(paper);
    else {
      const values = new Map<string, string>();
      const dataTransfer = {
        get types() { return [...values.keys()]; },
        setData: (type: string, value: string) => { values.set(type, value); },
        getData: (type: string) => values.get(type) ?? "",
      };
      fireEvent.dragStart(paper.closest(".paper-row")!, { dataTransfer });
      expect(values.has("application/x-lattice-paper")).toBe(true);
      fireEvent.drop(document.querySelector(".titlebar-main")!, { dataTransfer });
    }
    expect(await screen.findByText("Attention Is All You Need", { selector: ".active-document span" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });
    expect(invoke).toHaveBeenCalledWith("read_paper_blog_local", { arxivId: "1706.03762" });
    expect(invoke).not.toHaveBeenCalledWith("read_paper_blog", { arxivId: "1706.03762" });
    expect(document.querySelector(".paper-reader")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Attention overview" })).toBeInTheDocument();
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeInTheDocument();
    // The Blog has no masthead of its own, so the strip names the whole Paper;
    // its source is the way to the original.
    const identity = document.querySelector<HTMLElement>(".paper-identity")!;
    expect(within(identity).getByText("Attention Is All You Need")).toHaveClass("paper-identity-title");
    expect(within(identity).getByText("Vaswani and Shazeer")).toBeInTheDocument();
    fireEvent.click(within(identity).getByRole("button", { name: "arXiv 1706.03762, Open PDF in browser" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://arxiv.org/pdf/1706.03762"));

    // A Paper's panel switches between its Blog and the Paper itself; there is no Edit/Split/Preview for it.
    expect(screen.queryByRole("tablist", { name: "Document view" })).toBeNull();
    const paperContent = screen.getByRole("tablist", { name: "Paper content" });
    expect(within(paperContent).getByRole("tab", { name: "Blog" })).toHaveAttribute("aria-selected", "true");
    expect(within(paperContent).getByRole("tab", { name: "Paper" })).toBeInTheDocument();

    fireEvent.click(within(paperContent).getByRole("tab", { name: "Paper" }));
    const abstractHeading = await screen.findByRole("heading", { name: "Abstract" });
    const paperHeader = document.querySelector<HTMLElement>(".paper-visual-header");
    expect(paperHeader).not.toBeNull();
    expect(within(paperHeader!).getByRole("heading", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(within(paperHeader!).getByText("Ashish Vaswani · Noam Shazeer")).toBeInTheDocument();
    expect(paperHeader!.compareDocumentPosition(abstractHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("title: Attention Is All You Need")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    // Saving writes the whole file: the ticked task, and the metadata the reader never showed.
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await expectInvoked("write_project_file", {
      path: ".research/papers/1706.03762/paper.md", projectRoot: ROOT,
      content: expect.stringMatching(/- \[ \] Hidden metadata task[\s\S]*- \[x\] Review paper/),
    });
    expect(paper.closest(".paper-row")).toHaveClass("active");
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(paper.closest(".paper-row")).not.toHaveClass("active"));
  });

  it("paints an unfocused LaTeX snapshot in the live editor's syntax palette", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex") }), "\\documentclass{article}\n\\usepackage{url}"),
      list_papers: () => [attentionPaper()],
      read_paper: "# Attention\n\nPaper content.",
    });
    // Each token's highlight classes, so a different parser shows as different classes.
    const tokens = (root: Element) => [...root.querySelectorAll(".cm-line span")]
      .map((span) => `${span.textContent}:${span.className}`);
    const live = await findElement(".source-editor:not(.trellis-snapshot) .cm-content");
    await waitFor(() => expect(tokens(live).length).toBeGreaterThan(0));
    const liveTokens = tokens(live);

    await openPaper("Attention Is All You Need");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    const snapshot = await findElement(".trellis-snapshot .cm-content");
    await waitFor(() => expect(tokens(snapshot)).toEqual(liveTokens));
  });

  it("reads a paper beside the notes in the Reading layout, then returns to the writer's own", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md", "draft.md") }), "\\documentclass{main}"),
      list_papers: () => [attentionPaper({ hasBlog: true })],
      read_paper: "# Attention\n\nPaper content.",
      read_paper_blog_local: "# Attention overview\n\nBlog content.",
    });
    await openTreeFile("notes.md");
    await openPaper("Attention Is All You Need");
    await waitFor(() => expect(screen.getByRole("tab", { name: /Attention Is All You Need/ })).toHaveAttribute("aria-selected", "true"));
    // Read in the Paper's full text rather than its Blog.
    fireEvent.click(await screen.findByRole("tab", { name: "Paper" }));
    await screen.findByRole("heading", { name: "Attention" });
    const panel = (id: string) => document.querySelector(`[data-trellis-part="panel"][data-panel="${id}"]`);
    const layoutTab = (name: string) => within(document.querySelector(".trellis-presets")!).getByRole("tab", { name });
    expect(layoutTab("Workspace")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(layoutTab("Reading"));
    await waitFor(() => expect(panel("panel-reading")).toBeInTheDocument());
    expect(layoutTab("Reading")).toHaveAttribute("aria-selected", "true");
    // The paper is read with the library beside it; the notes have a panel of their own; the PDF has gone.
    expect(within(panel("panel-reading") as HTMLElement).getByRole("tab", { name: /Attention Is All You Need/ })).toBeInTheDocument();
    expect(within(panel("panel-notes") as HTMLElement).getByRole("tab", { name: /notes\.md/ })).toBeInTheDocument();
    expect(panel("panel-pdf")).not.toBeInTheDocument();

    // Writing the notes keeps the paper legible where it was.
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    const snapshot = await findElement(".trellis-paper-snapshot");
    await waitFor(() => expect(snapshot).toHaveTextContent("Paper content."));
    expect(snapshot).not.toHaveTextContent("Blog content.");
    expect(within(snapshot).getByRole("button", { name: "Open the reader" })).toBeInTheDocument();

    // A file opened while reading joins the notes; one closed stays closed.
    fireEvent.click(screen.getByRole("button", { name: "Show Project" }));
    await openTreeFile("draft.md");
    expect(within(panel("panel-notes") as HTMLElement).getByRole("tab", { name: /draft\.md/ })).toBeInTheDocument();
    const close = screen.getByRole("tab", { name: /main\.tex/ }).querySelector<HTMLElement>("[data-trellis-part=tab-close]")!;
    fireEvent.pointerDown(close, { button: 0 });
    fireEvent.click(close, { button: 0 });
    await waitFor(() => expect(screen.queryByRole("tab", { name: /main\.tex/ })).not.toBeInTheDocument());

    fireEvent.click(layoutTab("Workspace"));
    await waitFor(() => expect(panel("panel-reading")).not.toBeInTheDocument());
    expect(panel("panel-project")).toBeInTheDocument();
    expect(panel("panel-pdf")).toBeInTheDocument();
    for (const name of [/notes\.md/, /draft\.md/, /Attention Is All You Need/]) expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /main\.tex/ })).not.toBeInTheDocument();
    expect(layoutTab("Workspace")).toHaveAttribute("aria-selected", "true");
    // The document being written is the one in front.
    await waitForSelectedTab("draft.md");
  });

  it("shows a paper's figures and names its reader action while the notes are written beside it", async () => {
    const figure = "data:image/svg+xml;base64,PHN2Zy8+";
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md") }), "\\documentclass{main}"),
      list_papers: () => [attentionPaper()],
      read_paper: "# Attention\n\n![Figure 1](figure.svg)\n\nPaper content.",
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "image/svg+xml", base64: "PHN2Zy8+" }),
    });
    await openTreeFile("notes.md");
    await openPaper("Attention Is All You Need");
    await screen.findByRole("heading", { name: "Attention" });
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    const snapshot = await findElement(".trellis-paper-snapshot");
    await waitFor(() => expect(snapshot).toHaveTextContent("Paper content."));
    // The figure is a project file beside the paper's Markdown, read the way
    // the full reader reads it rather than requested from the webview by its
    // relative path.
    await waitFor(() => expect(within(snapshot).getByRole("img", { name: "Figure 1" })).toHaveAttribute("src", figure));
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: ".research/papers/1706.03762/figure.svg", projectRoot: ROOT });
    // A narrow paper header hides the action's text, so its name cannot come from that text.
    expect(within(snapshot).getByRole("button", { name: "Open the reader" })).toHaveAttribute("aria-label", "Open the reader");
  });

  it("shows an imported full text beside the notes block for block as the reader shows it", async () => {
    // The converter writes its metadata as YAML frontmatter. The reader drops
    // it, so the snapshot must too: the shared reading place is a top-level
    // block's index, and an extra block would move it in both directions.
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md") }), "\\documentclass{main}"),
      list_papers: () => [attentionPaper()],
      read_paper: "---\ntitle: Attention\narxiv_id: 1706.03762\n---\n\n# Attention\n\nPaper content.\n\n## Section 2\n\nMore content.",
    });
    await openTreeFile("notes.md");
    await openPaper("Attention Is All You Need");
    const heading = await screen.findByRole("heading", { name: "Section 2" });
    const blocks = (root: ParentNode) => [...root.querySelector(".ProseMirror")!.children].map((block) => block.textContent);
    const reader = blocks(heading.closest(".ProseMirror")!.parentElement!);
    expect(reader).toEqual(["Attention", "Paper content.", "Section 2", "More content."]);
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    const snapshot = await findElement(".trellis-paper-snapshot");
    await waitFor(() => expect(snapshot).toHaveTextContent("More content."));
    expect(blocks(snapshot)).toEqual(reader);
  });

  it("keeps a project PDF open beside the notes in the Reading layout", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md", "reference.pdf") }), "\\documentclass{main}"),
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "application/pdf", ranges: { length: 8, version: "v1" } }),
    });
    await openTreeFile("notes.md");
    fireEvent.click(await findProjectTreeItem("reference.pdf"));
    await waitForSelectedTab("reference.pdf");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    const reading = () => document.querySelector<HTMLElement>('[data-trellis-part="panel"][data-panel="panel-reading"]')!;
    await waitFor(() => expect(reading()).toBeInTheDocument());
    // Writing the notes: the PDF stays open where it was read rather than going to sleep.
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    expect(within(reading()).getByRole("tab", { name: /reference\.pdf/ })).toHaveAttribute("aria-selected", "true");
    await findElement(".trellis-pdf-snapshot");
    expect(screen.queryByText("Sleeping · click to open")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: "reference.pdf" });
  });

  it("keeps the notes active while the PDF beside them is paged, zoomed and searched", async () => {
    mockPdfDocument(() => pdfDocumentStub(12, {
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent: async () => ({ items: [] }),
    }));
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md", "reference.pdf") }), "\\documentclass{main}"),
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "application/pdf", ranges: { length: 8, version: "v1" } }),
    });
    await openTreeFile("notes.md");
    fireEvent.click(await findProjectTreeItem("reference.pdf"));
    await waitForSelectedTab("reference.pdf");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    const snapshot = await findElement(".trellis-pdf-snapshot");
    await within(snapshot).findByLabelText("PDF page 1");
    // One press on a field, as the browser delivers it: the press, then focus.
    const press = (field: HTMLElement) => {
      fireEvent.pointerDown(field, { button: 0 });
      field.focus();
    };
    // Activating the PDF from that focus swapped the snapshot for the live
    // host, taking the field just clicked with it.
    const settled = async (field: HTMLElement) => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      expect(document.querySelector(".trellis-pdf-snapshot")).toBe(snapshot);
      expect(field).toHaveFocus();
      expect(screen.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
    };
    const page = within(snapshot).getByLabelText("PDF page number");
    press(page);
    await settled(page);
    fireEvent.change(page, { target: { value: "7" } });
    fireEvent.keyDown(page, { key: "Enter" });
    expect(page).toHaveValue("7");
    for (const name of ["PDF zoom percentage", "Search PDF"]) {
      const field = within(snapshot).getByLabelText(name);
      press(field);
      await settled(field);
    }
    // The PDF's own tab still opens it.
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-trellis-part="panel"][data-panel="panel-reading"]')!)
      .getByRole("tab", { name: /reference\.pdf/ }));
    await waitFor(() => expect(document.querySelector(".trellis-pdf-snapshot")).not.toBeInTheDocument());
    expect(document.querySelector(".trellis-file-live .pdf-preview")).toBeInTheDocument();
  });

  it.each([["Enter"], [" "]])("opens the PDF beside the notes from its tab with %j after a field in it was used", async (key) => {
    mockPdfDocument(() => pdfDocumentStub(3, {
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent: async () => ({ items: [] }),
    }));
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md", "reference.pdf") }), "\\documentclass{main}"),
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "application/pdf", ranges: { length: 8, version: "v1" } }),
    });
    await openTreeFile("notes.md");
    fireEvent.click(await findProjectTreeItem("reference.pdf"));
    await waitForSelectedTab("reference.pdf");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    const snapshot = await findElement(".trellis-pdf-snapshot");
    // A field in the PDF used beside the notes: Trellis's focus is now on the
    // PDF while the notes stay App's active document.
    const page = await within(snapshot).findByLabelText("PDF page number");
    fireEvent.pointerDown(page, { button: 0 });
    page.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(document.querySelector(".trellis-pdf-snapshot")).toBe(snapshot);
    // Tabbing on to the PDF's tab and pressing it, as the keyboard does.
    // Trellis consumes the key, so no click follows, and reports no focus
    // change, since it already counts the PDF as focused.
    const tab = within(document.querySelector<HTMLElement>('[data-trellis-part="panel"][data-panel="panel-reading"]')!)
      .getByRole("tab", { name: /reference\.pdf/ });
    tab.focus();
    fireEvent.keyDown(tab, { key });
    await waitFor(() => expect(document.querySelector(".trellis-file-live .pdf-preview")).toBeInTheDocument());
    expect(document.querySelector(".trellis-pdf-snapshot")).not.toBeInTheDocument();
  });

  it("moves a project PDF beside the notes to its new version and notes its removal", async () => {
    mockPdfDocument(() => pdfDocumentStub(1, {
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent: async () => ({ items: [] }),
    }));
    let ranges = { length: 8, version: "v1" };
    let removed = false;
    const missing = () => new Error("That file or folder no longer exists.");
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md", "reference.pdf") }), "\\documentclass{main}"),
      read_project_asset: (args) => {
        if (removed) throw missing();
        return { path: argPath(args), mimeType: "application/pdf", ranges };
      },
      read_project_asset_range: () => { throw removed ? missing() : new Error("This PDF changed on disk."); },
    });
    await openTreeFile("notes.md");
    fireEvent.click(await findProjectTreeItem("reference.pdf"));
    await waitForSelectedTab("reference.pdf");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    const snapshot = await findElement(".trellis-pdf-snapshot");
    await within(snapshot).findByLabelText("PDF page 1");
    const lastRange = () => (vi.mocked(getDocument).mock.calls.at(-1)![0] as unknown as {
      range: { requestDataRange(begin: number, end: number): void };
    }).range;
    // Rewritten on disk while the notes are typed: the PDF beside them reads the new version.
    ranges = { length: 12, version: "v2" };
    lastRange().requestDataRange(0, 4);
    await waitFor(() => expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({
      range: expect.objectContaining({ length: 12 }),
    })));
    // Removed: it stays open beside the notes with a notice.
    removed = true;
    await within(snapshot).findByLabelText("PDF page 1");
    lastRange().requestDataRange(0, 4);
    expect(await within(snapshot).findByText("This PDF was removed from the project.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows the paper being read again when it is reopened from the library tabbed over it", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md") }), "\\documentclass{main}"),
      list_papers: () => [attentionPaper()],
      read_paper: "# Attention\n\nPaper content.",
    });
    await openTreeFile("notes.md");
    await openPaper("Attention Is All You Need");
    await waitForSelectedTab("Attention Is All You Need");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    const reading = await findElement<HTMLElement>('[data-trellis-part="panel"][data-panel="panel-reading"]');
    const paperTab = () => within(reading).getByRole("tab", { name: /Attention Is All You Need/ });
    const libraryTab = () => within(reading).getByRole("tab", { name: "Papers" });
    await waitFor(() => expect(paperTab()).toHaveAttribute("aria-selected", "true"));

    // The library covers the paper in their shared panel; the paper stays App's active document.
    fireEvent.click(libraryTab());
    await waitFor(() => expect(libraryTab()).toHaveAttribute("aria-selected", "true"));
    const reads = invokeCalls("read_paper").length;

    // Opening the same paper from the library used to re-read it and leave the library in front.
    // A keyboard open starts with focus on the library's own button.
    const libraryButton = await (await papersList()).findByTitle("Attention Is All You Need");
    libraryButton.focus();
    await openPaper("Attention Is All You Need");
    await waitFor(() => expect(invokeCalls("read_paper").length).toBeGreaterThan(reads));
    await waitFor(() => expect(paperTab()).toHaveAttribute("aria-selected", "true"));
    expect(libraryTab()).toHaveAttribute("aria-selected", "false");
    // Focus follows the paper instead of dropping to the body with the hidden library.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.closest("[data-view]")?.getAttribute("data-view"))
      .toBe(paperTab().getAttribute("data-view"));
    expect(await screen.findByRole("heading", { name: "Attention" })).toBeVisible();
    // The notes keep their own panel's selection.
    expect(within(await findElement<HTMLElement>('[data-trellis-part="panel"][data-panel="panel-notes"]'))
      .getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
  });

  it("moves a fully read PDF beside the notes to a same-size rewrite the watcher reports", async () => {
    // Every page already read makes no further range read for a refusal to
    // surface, and a same-size rewrite leaves the project tree as it was:
    // only the watcher's report (or the poll) can say the file changed.
    mockPdfDocument(() => pdfDocumentStub(1, {
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent: async () => ({ items: [] }),
    }));
    let ranges = { length: 8, version: "v1" };
    let removed = false;
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md", "reference.pdf") }), "\\documentclass{main}"),
      read_project_asset: (args) => {
        if (removed) throw new Error("That file or folder no longer exists.");
        return { path: argPath(args), mimeType: "application/pdf", ranges };
      },
    });
    await openTreeFile("notes.md");
    fireEvent.click(await findProjectTreeItem("reference.pdf"));
    await waitForSelectedTab("reference.pdf");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    const snapshot = await findElement(".trellis-pdf-snapshot");
    await within(snapshot).findByLabelText("PDF page 1");
    const loads = () => vi.mocked(getDocument).mock.calls.length;
    const loaded = loads();
    const fileChanged = (paths: string[]) => emitTauriEvent("project-fs-changed", { root: ROOT, paths });

    ranges = { length: 8, version: "v2" };
    fileChanged(["reference.pdf"]);
    await waitFor(() => expect(loads()).toBe(loaded + 1));
    expect(invokeCalls("read_project_asset_range")).toHaveLength(0);
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
    // Removed, it stays open beside the notes with a notice; restored, the
    // same lifecycle brings the new version in.
    removed = true;
    fileChanged(["reference.pdf"]);
    expect(await within(snapshot).findByText("This PDF was removed from the project.")).toHaveAttribute("role", "status");
    removed = false;
    ranges = { length: 8, version: "v3" };
    fileChanged(["reference.pdf"]);
    await waitFor(() => expect(within(snapshot).queryByText("This PDF was removed from the project.")).not.toBeInTheDocument());
    await waitFor(() => expect(loads()).toBe(loaded + 2));
  });

  it("brings back a PDF beside the notes whose first read failed once the watcher reports it", async () => {
    mockPdfDocument(() => pdfDocumentStub(1, {
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent: async () => ({ items: [] }),
    }));
    let removed = false;
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md", "reference.pdf") }), "\\documentclass{main}"),
      read_project_asset: (args) => {
        if (removed) throw new Error("That file or folder no longer exists.");
        return { path: argPath(args), mimeType: "application/pdf", ranges: { length: 8, version: "v1" } };
      },
    });
    await openTreeFile("notes.md");
    fireEvent.click(await findProjectTreeItem("reference.pdf"));
    await waitForSelectedTab("reference.pdf");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    // A clean build removed the PDF just as the notes are written beside it.
    removed = true;
    fireEvent.pointerDown(await findElement(".trellis-snapshot"), { button: 0 });
    await waitForSelectedTab("notes.md");
    await screen.findByText("Sleeping · click to open");
    expect(document.querySelector(".trellis-pdf-snapshot")).not.toBeInTheDocument();
    removed = false;
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["reference.pdf"] });
    const snapshot = await findElement(".trellis-pdf-snapshot");
    await within(snapshot).findByLabelText("PDF page 1");
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
  });

  it("leaves focus in the notes when the writer moves there while a reopened paper is read", async () => {
    let paperRead = deferred<string>();
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md") }), "\\documentclass{main}"),
      list_papers: () => [attentionPaper()],
      read_paper: () => paperRead.promise,
    });
    await openTreeFile("notes.md");
    await openPaper("Attention Is All You Need");
    act(() => paperRead.resolve("# Attention\n\nPaper content."));
    await waitForSelectedTab("Attention Is All You Need");
    fireEvent.click(within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: "Reading" }));
    const reading = await findElement<HTMLElement>('[data-trellis-part="panel"][data-panel="panel-reading"]');
    const paperTab = () => within(reading).getByRole("tab", { name: /Attention Is All You Need/ });
    const libraryTab = () => within(reading).getByRole("tab", { name: "Papers" });
    await waitFor(() => expect(paperTab()).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(libraryTab());
    await waitFor(() => expect(libraryTab()).toHaveAttribute("aria-selected", "true"));

    paperRead = deferred<string>();
    const reads = invokeCalls("read_paper").length;
    const libraryButton = await (await papersList()).findByTitle("Attention Is All You Need");
    libraryButton.focus();
    await openPaper("Attention Is All You Need");
    await waitFor(() => expect(invokeCalls("read_paper").length).toBeGreaterThan(reads));
    // The writer tabs over to the notes before the read lands.
    const notesTab = within(await findElement<HTMLElement>('[data-trellis-part="panel"][data-panel="panel-notes"]'))
      .getByRole("tab", { name: /notes\.md/ });
    notesTab.focus();
    act(() => paperRead.resolve("# Attention\n\nPaper content."));
    await waitFor(() => expect(paperTab()).toHaveAttribute("aria-selected", "true"));
    for (let frame = 0; frame < 2; frame += 1) {
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }
    expect(document.activeElement).toBe(notesTab);
  });

  it("opens a captured webpage without offering it as an arXiv PDF", async () => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [{
        arxivId: "web-0123456789abcdef", url: "https://example.com/research/article", title: "A captured research article",
        hasFullText: true, hasBlog: false,
      }],
      read_paper: "# A captured research article\n\nArticle content.",
    });
    await openPaper("A captured research article");
    const paperHeader = await findElement(".paper-visual-header");
    expect(within(paperHeader).getByRole("heading", { name: "A captured research article" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View original PDF" })).not.toBeInTheDocument();
    // A captured page's bundle key is not an arXiv id: the strip names its site.
    fireEvent.click(screen.getByRole("button", { name: "example.com, Open article in browser" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/research/article"));
  });

  it("streams ordinary PDFs, reuses complete bytes, and isolates failures and stale requests", async () => {
    const firstUrl = "https://mirros.ai/report/s-space.PDF?download=1#page=1";
    const secondUrl = "https://example.com/papers/second.pdf";
    const secondPreviewUrl = "http://127.0.0.1:3456/paper.pdf?token=test&url=second";
    const secondBytes = new TextEncoder().encode("%PDF second").buffer;
    const expectedSecondBytes = new Uint8Array(secondBytes.slice(0));
    const firstPreview = deferred<string>();
    let secondAttempts = 0;
    mockCommands({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        { arxivId: "web-first", url: firstUrl, title: "First PDF", hasFullText: true, hasBlog: false },
        { arxivId: "web-second", url: secondUrl, title: "Second PDF", hasFullText: true, hasBlog: false },
      ],
      read_paper: (args) => `# ${(args as { arxivId: string }).arxivId}`,
      paper_pdf_preview_url: (args) => {
        if ((args as { url: string }).url === firstUrl) return firstPreview.promise;
        secondAttempts += 1;
        if (secondAttempts === 1) throw new Error("remote PDF unavailable");
        return secondPreviewUrl;
      },
    });
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    mockPdfDocument(() => pdfDocumentStub(2, { render: () => renderTask }, {
      getData: vi.fn(async () => new Uint8Array(secondBytes)), cleanup: vi.fn(),
    }));
    const viewOriginal = async () => fireEvent.click(await screen.findByRole("button", { name: "View original PDF" }));

    renderApp();
    await openPaper("First PDF");
    await viewOriginal();
    await expectInvoked("paper_pdf_preview_url", { url: firstUrl });
    expect(screen.getByRole("status")).toHaveTextContent("Loading PDF…");
    expect(screen.getByRole("status")).toHaveClass("pdf-loading");
    expect(getDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "mirros.ai, Open PDF in browser" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(firstUrl));

    fireEvent.click(screen.getByTitle("Second PDF"));
    await screen.findByRole("heading", { name: "Second PDF" });
    await viewOriginal();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not load PDF"));
    expect(invoke).toHaveBeenCalledWith("paper_pdf_preview_url", { url: secondUrl });
    firstPreview.resolve("http://127.0.0.1:3456/paper.pdf?token=test&url=first");
    await Promise.resolve();
    expect(getDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to Paper" }));
    await viewOriginal();
    await waitFor(() => expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: secondPreviewUrl })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Back to Paper" }));
    await viewOriginal();
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));
    expect(secondAttempts).toBe(2);
    const loadedSource = vi.mocked(getDocument).mock.calls.at(-1)?.[0] as { data?: ArrayBuffer; url?: string } | undefined;
    expect(loadedSource?.url).toBeUndefined();
    expect(new Uint8Array(loadedSource?.data ?? new ArrayBuffer(0))).toEqual(expectedSecondBytes);
    expect(screen.getByRole("textbox", { name: "PDF page number" })).toHaveValue("1");
  });

  it("streams an arXiv PDF and reopens its complete in-memory bytes", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 streamed arXiv paper").buffer;
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const pdf = pdfDocumentStub(1, { render: () => renderTask }, {
      getData: vi.fn(async () => new Uint8Array(pdfBytes)), cleanup: vi.fn(),
    });
    mockPdfDocument(() => pdf);
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [{ arxivId: "1706.03762v7", title: "Attention Is All You Need", hasFullText: true, hasBlog: false }],
      read_paper: PAPER_ABSTRACT,
    });
    await openPaper("Attention Is All You Need");
    const viewOriginalPdf = await screen.findByRole("button", { name: "View original PDF" });
    expect(viewOriginalPdf.closest('[data-tour="paper-actions"]')).not.toBeNull();
    fireEvent.click(viewOriginalPdf);

    await waitFor(() => expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: "https://arxiv.org/pdf/1706.03762v7" })));
    const backToPaper = await screen.findByRole("button", { name: "Back to Paper" });
    const openInBrowser = screen.getByRole("button", { name: "arXiv 1706.03762v7, Open PDF in browser" });
    const downloadPdf = screen.getByRole("button", { name: "Download PDF" });
    const paperPdfToolbar = backToPaper.closest(".pdf-toolbar");
    expect(paperPdfToolbar).toContainElement(downloadPdf);
    expect(backToPaper.querySelector("svg")).toHaveClass("lucide-arrow-left");
    expect(backToPaper.querySelector("svg")).toHaveAttribute("stroke-width", "2");
    // The identity strip stays over the original PDF: its title, and its source
    // as the one browser action; the PDF button shows it is the view open.
    const strip = document.querySelector<HTMLElement>(".paper-reader-header")!;
    expect(within(strip).getByText("Attention Is All You Need")).toBeInTheDocument();
    expect(strip).toContainElement(openInBrowser);
    expect(paperPdfToolbar).not.toContainElement(openInBrowser);
    expect(within(strip).getByRole("button", { name: "View original PDF" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(downloadPdf).toBeEnabled());
    fireEvent.click(openInBrowser);
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://arxiv.org/pdf/1706.03762v7"));

    // Pressing the PDF button again returns to the Paper, as Back does.
    fireEvent.click(within(strip).getByRole("button", { name: "View original PDF" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to Paper" })).toBeNull());
    expect(screen.getByRole("button", { name: "View original PDF" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "View original PDF" }));

    await waitFor(() => {
      const remoteLoads = vi.mocked(getDocument).mock.calls
        .filter(([source]) => (source as { url?: string }).url === "https://arxiv.org/pdf/1706.03762v7");
      expect(remoteLoads).toHaveLength(1);
      const reopenedSource = vi.mocked(getDocument).mock.calls.at(-1)?.[0] as { data?: Uint8Array; url?: string } | undefined;
      expect(reopenedSource?.url).toBeUndefined();
      expect(new Uint8Array(reopenedSource?.data ?? new ArrayBuffer(0))).toEqual(new Uint8Array(pdfBytes));
    });
  });

  it("publishes a visually selected Markdown block as Agent context", async () => {
    persistLayout(ROOT, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "pdf" });
    await loadVisualMarkdownEditorModule();
    renderApp({
      ...projectCommands(markdownSnapshot(), "## Selected context\n\nUnselected paragraph"),
      list_editor_comments: () => ["notes.md", "other.tex"].map((path) => ({
        id: path, path, from: 3, to: 19, quote: "Selected context", prefix: "## ", suffix: "",
        body: "Explain the evidence", authorId: "reviewer", authorName: "Reviewer",
        resolved: false, replies: [], createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
      })),
    });
    const { frame, postMessage } = await openAgentFrame({ ready: true });
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" }, { timeout: 15_000 });
    const editor = visualEditorOf(surface);
    act(() => {
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    });

    type HostContext = { editor?: { selection?: string } };
    const hostContexts = () => postedOfType<HostContext>(postMessage, "lattice:host-context");
    await waitFor(() => expect(hostContexts().some((context) => context.editor?.selection === "## Selected context")).toBe(true));

    // jsdom has no layout: give the two blocks their rows, then hover the heading's.
    const [heading, paragraph] = [...surface.children];
    vi.spyOn(heading!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 400, 28));
    vi.spyOn(paragraph!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 156, 400, 28));
    fireEvent.mouseMove(heading!, { clientX: 150, clientY: 112 });
    const grip = await screen.findByRole("button", { name: "Select block" });
    fireEvent.pointerDown(grip, { button: 0, pointerId: 7, pointerType: "mouse" });
    fireEvent.pointerUp(window, { button: 0, pointerId: 7, pointerType: "mouse" });
    fireEvent.click(grip);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);

    // The grip focuses the same visual-editor surface after selecting the
    // block. That focus must not clear the context it just published.
    fireEvent.focus(surface);

    const contextCount = hostContexts().length;
    postWindowMessage(frame.contentWindow, { type: "lattice:request-host-context" });
    await waitFor(() => expect(hostContexts()).toHaveLength(contextCount + 1));
    expect(hostContexts().at(-1)?.editor?.selection).toBe("## Selected context");
    postWindowMessage(frame.contentWindow, {
      type: "lattice:request-host-context", requestId: "fresh-comments", workspaceRoot: ROOT, refreshComments: true,
    });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "fresh-comments",
      editorComments: expect.objectContaining({
        comments: [expect.objectContaining({ path: "notes.md", body: "Explain the evidence", anchorStatus: "exact" })],
        overleaf: { status: "not-linked" },
      }),
    }), synaraHook.runtime.origin));
    postWindowMessage(frame.contentWindow, {
      type: "synara:editor-comments-tool-request", version: 1, id: "all-comments", workspaceRoot: ROOT,
      args: {}, expiresAt: Date.now() + 10_000,
    });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "lattice:editor-comments-tool-result", id: "all-comments", ok: true,
      result: expect.objectContaining({ totalCount: 2, comments: expect.arrayContaining([
        expect.objectContaining({ path: "notes.md" }), expect.objectContaining({ path: "other.tex" }),
      ]) }),
    }), synaraHook.runtime.origin));
  });

  it("gives the Agent a PNG path for a selected WebP Markdown image", async () => {
    persistLayout(ROOT, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "pdf" });
    renderApp({
      ...projectCommands(markdownSnapshot("notes.md", [fileNode("notes.md"), dirNode("figures", [fileNode("figures/figure.webp")])]),
        "![Figure](figures/figure.webp)"),
      read_project_asset: () => ({ path: "figures/figure.webp", mimeType: "image/webp", base64: btoa("webp-bytes") }),
      prepare_latex_figure: "figures/figure-converted.png",
    });
    const { postMessage } = await openAgentFrame({ ready: true });
    const editor = visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
    act(() => {
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    });
    await expectInvoked("prepare_latex_figure", { path: "figures/figure.webp", projectRoot: ROOT });
    type ImageContext = {
      editor?: { selection?: string; selectionImage?: { sourcePath?: string; agentReadablePath?: string; mimeType?: string } };
    };
    await waitFor(() => expect(postedOfType<ImageContext>(postMessage, "lattice:host-context").some(({ editor }) => (
      editor?.selection === "![Figure](figures/figure.webp)" && editor.selectionImage?.sourcePath === "figures/figure.webp"
      && editor.selectionImage.agentReadablePath === "figures/figure-converted.png" && editor.selectionImage.mimeType === "image/png"
    ))).toBe(true));
  });

  // The outgoing notes must never be saved over the Paper being opened.
  const NOTES_INTO_PAPER = expect.objectContaining({
    path: ".research/papers/2407.06438/paper.md", content: expect.stringContaining("Original notes"),
  });

  /** Opens notes.md ("Original notes") in the visual editor beside the Paper `title`, returning that editor. */
  const renderNotesBesidePaper = async (title: string, commands: Commands) => {
    renderApp({
      ...refreshableProject(markdownSnapshot(), "Original notes"),
      list_papers: () => [{ arxivId: "2407.06438", title, hasFullText: true }], ...commands,
    });
    return visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
  };

  it("publishes the current visual document before opening a Paper", async () => {
    let resolveWrite: (() => void) | null = null;
    const editor = await renderNotesBesidePaper("Paper target", {
      read_paper: "# Paper body",
      write_project_file: () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    });
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size, " updated"));
    fireEvent.click(await screen.findByRole("button", { name: /Paper target.*2407\.06438/i }));
    expect(screen.getByText("Opening Paper target…")).toBeInTheDocument();
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    // The target Paper read is independent of writing the outgoing notes, so
    // both should be in flight rather than paying write latency first.
    expect(resolveWrite).not.toBeNull();
    act(() => resolveWrite?.());
    await waitFor(() => expect(vi.mocked(invoke).mock.calls).toContainEqual(["write_project_file", expect.objectContaining({
      path: "notes.md", content: expect.stringMatching(/Original notes[\s\S]*updated/), projectRoot: ROOT,
    })]));
    expect(await screen.findByRole("heading", { name: "Paper body" })).toBeInTheDocument();
    expect(screen.queryByText("Original notes updated")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", NOTES_INTO_PAPER);
  });

  it("keeps the current document when it is edited during a delayed Paper read", async () => {
    const paperRead = deferred<string>();
    const editor = await renderNotesBesidePaper("Delayed paper", { read_paper: () => paperRead.promise, write_project_file: undefined });
    fireEvent.click(await screen.findByRole("button", { name: /Delayed paper.*2407\.06438/i }));
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size, " late edit"));
    act(() => paperRead.resolve("# Paper must not replace the edit"));
    await act(async () => { await Promise.resolve(); });
    expect(editor.getText()).toMatch(/Original notes[\s\S]*late edit/);
    expect(screen.queryByRole("heading", { name: "Paper must not replace the edit" })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", NOTES_INTO_PAPER);
  });

  it("keeps only the latest Paper when overlapping reads finish out of order", async () => {
    const paperResolvers = new Map<string, (value: string) => void>();
    renderApp({
      ...refreshableProject(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        { arxivId: "2407.06438", title: "First paper", hasFullText: true },
        { arxivId: "2103.00020", title: "Second paper", hasFullText: true },
      ],
      read_paper: (args) => new Promise<string>((resolve) => { paperResolvers.set((args as { arxivId: string }).arxivId, resolve); }),
    });
    await openPaper("First paper");
    await waitFor(() => expect(paperResolvers.has("2407.06438")).toBe(true));
    fireEvent.click(screen.getByTitle("Second paper"));
    await waitFor(() => expect(paperResolvers.has("2103.00020")).toBe(true));
    act(() => paperResolvers.get("2103.00020")?.("# Second body"));
    expect(await screen.findByRole("heading", { name: "Second body" })).toBeInTheDocument();
    act(() => paperResolvers.get("2407.06438")?.("# First body"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Second paper", { selector: ".active-document span" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Second body" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "First body" })).toBeNull();
  });

  it("cancels a pending Paper when the user opens a local file", async () => {
    const paperRead = deferred<string>();
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md") })), read_project_file: readPathContent,
      list_papers: () => [{ arxivId: "2407.06438", title: "Delayed paper", hasFullText: true }],
      read_paper: () => paperRead.promise, read_paper_blog_local: null,
    });
    await waitFor(() => expect(paneContent("primary")).toHaveTextContent("content:main.tex"));
    await openPaper("Delayed paper");
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    expect(screen.getByText("Opening Delayed paper…")).toBeInTheDocument();
    fireEvent.click(await findProjectTreeItem("notes.md"));
    await waitFor(() => expect(paneContent("primary")).toHaveTextContent("content:notes.md"));
    expect(screen.queryByText("Opening Delayed paper…")).toBeNull();
    act(() => paperRead.resolve("# Paper must stay closed"));
    await act(async () => { await Promise.resolve(); });
    expect(paneContent("primary")).toHaveTextContent("content:notes.md");
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("heading", { name: "Paper must stay closed" })).toBeNull();
  });

  it("remembers the selected paper content when reopening an article", async () => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"), list_papers: () => [attentionPaper({ hasBlog: true })],
      read_paper: PAPER_ABSTRACT, read_paper_blog_local: "# Attention overview\n\nBlog content.",
    });
    await openPaper("Attention Is All You Need");
    const paperContent = await screen.findByRole("tablist", { name: "Paper content" });
    fireEvent.click(within(paperContent).getByRole("tab", { name: "Paper" }));
    await waitFor(() => expect(within(paperContent).getByRole("tab", { name: "Paper" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(await findProjectTreeItem("main.tex"));
    const paper = await (await papersList()).findByTitle("Attention Is All You Need");
    await waitFor(() => expect(paper.closest(".paper-row")).not.toHaveClass("active"));
    fireEvent.click(paper);
    await waitFor(() => expect(invokeCalls("read_paper")).toHaveLength(2));
    const reopenedPaperContent = await screen.findByRole("tablist", { name: "Paper content" });
    await waitFor(() => expect(within(reopenedPaperContent).getByRole("tab", { name: "Paper" })).toHaveAttribute("aria-selected", "true"));
  });

  it("shows only edit and delete actions on a Papers row", async () => {
    setAutoBuildMode("manual");
    const paper = attentionPaper({ citationKey: "vaswani2017attention" });
    renderApp({ ...refreshableProject(projectSnapshot(), "See "), list_papers: () => [paper] });
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    expect(screen.queryByTitle("Insert citation for vaswani2017attention")).not.toBeInTheDocument();
    expect(await screen.findByTitle("Edit bibliography entry")).toBeInTheDocument();
    expect(await screen.findByTitle("Remove Attention Is All You Need")).toBeInTheDocument();
  });

  it("saves the visible source before checking whether a paper is still cited", async () => {
    setAutoBuildMode("manual");
    const paper = SINGLE_TRANSFORMER;
    let diskSource = "See \\cite{chen2024single}.\n";
    let sourceAtPreview = "";
    renderApp({
      ...refreshableProject(), read_project_file: (args) => argPath(args) === "main.tex" ? diskSource : "",
      write_project_file: (args) => {
        const write = args as { path: string; content: string };
        if (write.path === "main.tex") diskSource = write.content;
      },
      list_papers: () => [paper],
      remove_reference: (args) => {
        if ((args as { citationMode?: string }).citationMode === "preview") {
          sourceAtPreview = diskSource;
          return { key: paper.citationKey, removed: false, blockers: [], changedFiles: [], removedCitations: 0 };
        }
        return { key: paper.citationKey, removed: true, blockers: [], changedFiles: ["references.bib"], removedCitations: 0 };
      },
    });
    const view = await findEditorView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "The citation was removed.\n" } });
    fireEvent.click(await screen.findByTitle("Remove A Single Transformer"));
    await waitFor(() => expect(sourceAtPreview).toBe("The citation was removed.\n"));
    expect(sourceAtPreview).not.toContain("chen2024single");
  });

  it("offers cited-paper removal with and without its citation commands", async () => {
    setAutoBuildMode("manual");
    const paper = SINGLE_TRANSFORMER;
    let diskSource = "See \\cite{chen2024single}.\n";
    renderApp({
      ...refreshableProject(), read_project_file: (args) => argPath(args) === "main.tex" ? diskSource : "",
      list_papers: () => [paper],
      remove_reference: (args) => {
        const citationMode = (args as { citationMode?: string }).citationMode;
        if (citationMode === "preview") {
          return {
            key: paper.citationKey, removed: false, changedFiles: [], removedCitations: 0,
            blockers: [{ kind: "citation", symbol: paper.citationKey, role: "reference", path: "main.tex", line: 1, snippet: diskSource }],
          };
        }
        const before = diskSource;
        const removeCitations = citationMode === "remove";
        if (removeCitations) diskSource = "See .\n";
        const bibliography = { path: "references.bib", before: "@article{chen2024single}\n", after: "" };
        return {
          key: paper.citationKey, removed: true, blockers: [], transactionId: "remove-chen",
          changedFiles: removeCitations ? ["main.tex", "references.bib"] : ["references.bib"],
          removedCitations: removeCitations ? 1 : 0,
          changes: removeCitations ? [{ path: "main.tex", before, after: diskSource }, bibliography] : [bibliography],
        };
      },
    }, { confirmations: true });
    fireEvent.click(await screen.findByTitle("Remove A Single Transformer"));
    const dialog = await screen.findByRole("dialog", { name: "Remove “A Single Transformer” from the bibliography?" });
    expect(dialog).toHaveAccessibleDescription(/cited in 1 place.*main\.tex:1.*leave them unresolved/i);
    fireEvent.click(screen.getByRole("button", { name: "Remove citations too" }));

    await expectInvoked("remove_reference", { key: "chen2024single", citationMode: "remove", projectRoot: ROOT });
    await expectEditorText("See .\n");
  });
});
