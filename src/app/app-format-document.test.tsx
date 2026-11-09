import {
  editorViewAt, expectNotification, fileNodes, invokeCalls, openTreeFile, projectSnapshot, refreshableProject, type Commands,
} from "./app-test-utils";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";

const { renderApp } = appHarness({ documentCanvas });

const pathOf = (args: InvokeArgs | undefined) => (args as { path?: string } | undefined)?.path;
const MAIN = "\\begin{document}\n\\section{Long}\nUnformatted\n\\end{document}\n";
const FORMATTED = "\\begin{document}\n  \\section{Long}\n  Formatted by latexindent\n\\end{document}\n";
const OTHER = "\\section{Other}\nA different file\n";
const editorText = () => document.querySelector(".source-editor .cm-content")?.textContent ?? "";

/** A project whose latexindent answers only when the test says so. */
function slowFormatter() {
  let finish: (formatted: string) => void = () => {};
  const commands = {
    ...refreshableProject(projectSnapshot({ trusted: true, files: fileNodes("main.tex", "other.tex") })),
    read_project_file: (args) => (pathOf(args) === "other.tex" ? OTHER : MAIN),
    write_project_file: (args) => ({ content: (args as { content: string }).content, hadConflicts: false }),
    format_latex: () => new Promise<string>((resolve) => { finish = resolve; }),
  } satisfies Commands;
  return { commands, finish: (formatted: string) => finish(formatted) };
}

async function formatFromPalette() {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
  const palette = await screen.findByRole("searchbox", { name: "Command palette" });
  fireEvent.change(palette, { target: { value: "Format document" } });
  fireEvent.keyDown(palette, { key: "Enter" });
  await waitFor(() => expect(invokeCalls("format_latex")).toHaveLength(1));
}

// latexindent takes seconds on a long file. Its result went to whichever
// file was open when it came back, so formatting main.tex and switching to
// other.tex meanwhile turned other.tex into main.tex, and autosave wrote that
// to disk (implicit-state audit S4).
describe("Format document", () => {
  it("formats the file it was run on", async () => {
    const formatter = slowFormatter();
    renderApp(formatter.commands);
    await openTreeFile("main.tex");
    await waitFor(() => expect(editorText()).toContain("Unformatted"));

    await formatFromPalette();
    formatter.finish(FORMATTED);
    await waitFor(() => expect(editorText()).toContain("Formatted by latexindent"));
  });

  it("drops a result that comes back after the writer switched files, and says so", async () => {
    const formatter = slowFormatter();
    renderApp(formatter.commands);
    await openTreeFile("main.tex");
    await waitFor(() => expect(editorText()).toContain("Unformatted"));

    await formatFromPalette();
    await openTreeFile("other.tex");
    await waitFor(() => expect(editorText()).toContain("A different file"));
    formatter.finish(FORMATTED);

    await expectNotification(/main\.tex changed while it was being formatted, so the result was not applied/);
    expect(editorText()).toContain("A different file");
    expect(editorText()).not.toContain("Formatted by latexindent");
    expect(invokeCalls("write_project_file", (args) => (args as { content?: string }).content === FORMATTED)).toEqual([]);

    await openTreeFile("main.tex");
    await waitFor(() => expect(editorText()).toContain("Unformatted"));
  });

  it("keeps what the writer typed into the file while it was being formatted", async () => {
    const formatter = slowFormatter();
    renderApp(formatter.commands);
    await openTreeFile("main.tex");
    await waitFor(() => expect(editorText()).toContain("Unformatted"));

    await formatFromPalette();
    const view = editorViewAt(".source-editor .cm-editor");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "Typed meanwhile\n" }, userEvent: "input.type" });
    formatter.finish(FORMATTED);

    await expectNotification(/main\.tex changed while it was being formatted/);
    expect(editorText()).toContain("Typed meanwhile");
    expect(editorText()).not.toContain("Formatted by latexindent");
  });
});
