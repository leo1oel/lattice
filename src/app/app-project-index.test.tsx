import { projectCommands, projectSnapshot, deferred, pause, expectEditorText, visibleToasts, appendToEditor, expectInvoked } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { getAppToastOptions } from "../telemetry/app-log-store";

/**
 * The project's citation and label index as the editor checks against it: not
 * before it lands, and never silently off when a read fails or leaves files out.
 */
const { renderApp } = appHarness({ documentCanvas });

const SOURCE = "See \\cite{known}, \\cite{missing}, \\ref{fig:model} and \\ref{fig:gone}.";
const CITATIONS = { skipped: [], citations: [{ key: "known", title: "", authors: "", year: "", venue: "" }] };
const LABELS = { skipped: [], references: [{ label: "fig:model", kind: "figure", title: "", snippet: "", path: "sections/a.tex", line: 1 }] };
const CHECKED = ["Unknown citation key “missing”.", "Unknown label “fig:gone”."];
const NOT_UTF8 = "stream did not contain valid UTF-8";

const diagnostics = (view: EditorView) => {
  const found: string[] = [];
  forEachDiagnostic(view.state, (diagnostic) => found.push(diagnostic.message));
  return found;
};
const indexToasts = () => visibleToasts("Labels and citations");

describe("project index", () => {
  it("opens the document before its label index lands, and checks it only against that index", async () => {
    const citations = deferred<unknown>();
    const references = deferred<unknown>();
    renderApp({ ...projectCommands(projectSnapshot(), SOURCE), list_citations: () => citations.promise, list_references: () => references.promise });
    const view = await expectEditorText(SOURCE);
    // Past the linter's delay: an index that is not this project's yet reports nothing.
    await pause(600);
    expect(diagnostics(view)).toEqual([]);

    citations.resolve(CITATIONS);
    references.resolve(LABELS);
    await waitFor(() => expect(diagnostics(view)).toEqual(CHECKED));
    expect(indexToasts()).toEqual([]);
  });

  it.each(["list_citations", "list_references"])("says the checks are off when %s fails, and Check again turns them on", async (failing) => {
    let fail = true;
    const read = (command: string, index: unknown) => () => (fail && command === failing ? Promise.reject(NOT_UTF8) : index);
    renderApp({
      ...projectCommands(projectSnapshot(), SOURCE),
      list_citations: read("list_citations", CITATIONS), list_references: read("list_references", LABELS),
    });
    const view = await expectEditorText(SOURCE);
    await waitFor(() => expect(indexToasts().map((toast) => toast?.title)).toEqual(["Label and citation checks are off"]));
    expect(indexToasts()[0]?.detail).toContain(NOT_UTF8);
    // A half-read index would call every key it missed unknown, so nothing is checked yet.
    await pause(600);
    expect(diagnostics(view)).toEqual([]);

    const checkAgain = () => act(async () => { await getAppToastOptions(indexToasts()[0]!.id)?.primaryAction?.onClick(); });
    // The click closes the toast; a read that fails again says so again.
    await checkAgain();
    await waitFor(() => expect(indexToasts().map((toast) => toast?.title)).toEqual(["Label and citation checks are off"]));
    fail = false;
    await checkAgain();
    await waitFor(() => expect(diagnostics(view)).toEqual(CHECKED));
    expect(indexToasts()).toEqual([]);
  });

  it("reads a failed label index again on the next save", async () => {
    let fail = true;
    renderApp({
      ...projectCommands(projectSnapshot(), SOURCE), write_project_file: undefined,
      list_citations: () => CITATIONS, list_references: () => (fail ? Promise.reject(NOT_UTF8) : LABELS),
    });
    await expectEditorText(SOURCE);
    await waitFor(() => expect(indexToasts()).toHaveLength(1));

    fail = false;
    const view = await appendToEditor(" Saved.");
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await expectInvoked("write_project_file", expect.objectContaining({ path: "main.tex" }));
    await waitFor(() => expect(diagnostics(view)).toEqual(CHECKED));
    expect(indexToasts()).toEqual([]);
  });

  it("names the files it left out, and checks against the rest", async () => {
    renderApp({
      ...projectCommands(projectSnapshot(), SOURCE),
      list_citations: () => ({ ...CITATIONS, skipped: [{ path: "legacy.bib", reason: "notUtf8" }] }),
      list_references: () => ({
        ...LABELS,
        skipped: [{ path: "archive/old-draft.tex", reason: "notUtf8" }, { path: "locked.tex", reason: "unreadable", message: "Permission denied" }],
      }),
    });
    const view = await expectEditorText(SOURCE);
    await waitFor(() => expect(diagnostics(view)).toEqual(CHECKED));
    const [toast] = indexToasts();
    expect(toast?.title).toBe("Some files are left out of label and citation checks");
    expect(toast?.detail).toContain("convert to UTF-8 to include: legacy.bib, archive/old-draft.tex");
    expect(toast?.detail).toContain("Could not be read: locked.tex (Permission denied)");
  });
});
