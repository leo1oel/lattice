import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { acceptCompletion, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { redo, undo } from "@codemirror/commands";
import { highlightingFor, syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { afterEach, expect, it } from "vitest";
import { CodeMirrorHost } from "./codemirror-host";
import { loadTextLanguageExtensions } from "./editor-languages";
import { retainParkedEditors } from "./parked-editors";

afterEach(() => {
  cleanup();
  retainParkedEditors(null, []);
});

const NONE: Extension[] = [];
const host = (path: string, label: string, extensions = NONE) => (
  <CodeMirrorHost
    key={path}
    label={label}
    value={`text of ${path}`}
    extensions={extensions}
    park={{ root: "/projects/thesis", path }}
    onChange={() => {}}
    onUpdate={() => {}}
    onCreateEditor={() => {}}
  />
);

it("offers Python names and keywords in a highlighted source editor", async () => {
  let view: EditorView | null = null;
  const extensions = await loadTextLanguageExtensions("scripts/plot.py");
  const source = "def render_figure():\n    return 42\n\nren";
  render(
    <CodeMirrorHost
      label="plot.py — source"
      value={source}
      extensions={extensions}
      onChange={() => {}}
      onUpdate={() => {}}
      onCreateEditor={(created) => { view = created; }}
    />,
  );
  expect(screen.getByRole("textbox", { name: "plot.py — source" })).toHaveTextContent("render_figure");
  expect(syntaxTree(view!.state).toString()).toContain("FunctionDefinition");
  expect(highlightingFor(view!.state, [tags.definitionKeyword])).toEqual(expect.any(String));
  act(() => {
    view!.dispatch({ selection: { anchor: source.length } });
    expect(startCompletion(view!)).toBe(true);
  });
  await waitFor(() => expect(currentCompletions(view!.state).map((option) => option.label)).toContain("render_figure"));
  // CodeMirror briefly ignores acceptance while a newly opened list settles.
  await waitFor(() => {
    let accepted = false;
    act(() => { accepted = acceptCompletion(view!); });
    expect(accepted).toBe(true);
  });
  expect(view!.state.doc.toString()).toBe(source.replace(/ren$/, "render_figure"));

  act(() => {
    const end = view!.state.doc.length;
    view!.dispatch({
      changes: { from: end, insert: "\nimp" },
      selection: { anchor: end + 4 },
      userEvent: "input.type",
    });
  });
  await waitFor(() => expect(currentCompletions(view!.state).map((option) => option.label)).toContain("import"));
});

it("names the source textbox after its document, across renames, reconfigures and resumed documents", () => {
  const view = render(host("main.tex", "main.tex — LaTeX source"));
  const textbox = screen.getByRole("textbox", { name: "main.tex — LaTeX source" });
  // The name joins CodeMirror's own textbox semantics; it replaces none of them.
  expect(textbox).toHaveClass("cm-content");
  expect(textbox).toHaveAttribute("aria-multiline", "true");

  view.rerender(host("main.tex", "paper.tex — LaTeX source"));
  expect(screen.getByRole("textbox", { name: "paper.tex — LaTeX source" })).toBe(textbox);
  // A reconfigure (new extensions) keeps the current name, or takes one given with it.
  const wrapping = [EditorView.lineWrapping];
  view.rerender(host("main.tex", "paper.tex — LaTeX source", wrapping));
  expect(screen.getByRole("textbox", { name: "paper.tex — LaTeX source" })).toBeInTheDocument();
  view.rerender(host("main.tex", "draft.tex — LaTeX source"));
  expect(screen.getByRole("textbox", { name: "draft.tex — LaTeX source" })).toBeInTheDocument();

  // Another document, then back: the parked state resumes under the name it is given now.
  view.rerender(host("notes.md", "notes.md — Markdown source"));
  expect(screen.getByRole("textbox", { name: "notes.md — Markdown source" })).toBeInTheDocument();
  view.rerender(host("main.tex", "main.tex — LaTeX source"));
  expect(screen.getByRole("textbox", { name: "main.tex — LaTeX source" })).toBeInTheDocument();
});

it("keeps a collaborator's or agent's text out of the writer's undo history", async () => {
  let view: EditorView | null = null;
  const emitted: string[] = [];
  const outside = new Set<string>();
  const live = (value: string) => (
    <CodeMirrorHost
      key="main.tex"
      label="main.tex — LaTeX source"
      value={value}
      extensions={NONE}
      isOutsideValue={(text) => outside.has(text)}
      onChange={(text) => emitted.push(text)}
      onUpdate={() => {}}
      onCreateEditor={(created) => { view = created; }}
    />
  );
  const page = render(live("Our method works.\n"));
  act(() => { view!.dispatch({ changes: { from: 0, insert: "Indeed, " }, userEvent: "input.type" }); });
  const typed = emitted.at(-1)!;
  // Past the typing latch and CodeMirror's undo grouping.
  await new Promise((resolve) => setTimeout(resolve, 650));
  // A collaborator's sentence (Overleaf) or an agent's write (disk) arrives through `value`.
  const remote = `${typed}A collaborator added this sentence.\n`;
  outside.add(remote);
  page.rerender(live(remote));
  expect(view!.state.doc.toString()).toBe(remote);

  // ⌘Z takes back the writer's own "Indeed, " and keeps the collaborator's sentence.
  act(() => { undo(view!); });
  expect(view!.state.doc.toString()).toBe("Our method works.\nA collaborator added this sentence.\n");
  expect(emitted.at(-1)).toBe("Our method works.\nA collaborator added this sentence.\n");
  // Nothing else is the writer's to undo; redo brings their words back where they were.
  expect(undo(view!)).toBe(false);
  act(() => { redo(view!); });
  expect(view!.state.doc.toString()).toBe(remote);

  // The writer's own edits that arrive through `value` (an inserted figure) stay undoable.
  await new Promise((resolve) => setTimeout(resolve, 650));
  const figure = `${remote}\\begin{figure}\\end{figure}\n`;
  page.rerender(live(figure));
  act(() => { undo(view!); });
  expect(view!.state.doc.toString()).toBe(remote);
});

it("keeps a collaborator's text that arrives mid-typing when the writer types on before it is shown", async () => {
  let view: EditorView | null = null;
  const emitted: string[] = [];
  const outside = new Set<string>();
  const live = (value: string) => (
    <CodeMirrorHost
      key="main.tex"
      label="main.tex — LaTeX source"
      value={value}
      extensions={NONE}
      isOutsideValue={(text) => outside.has(text)}
      onChange={(text) => emitted.push(text)}
      onUpdate={() => {}}
      onCreateEditor={(created) => { view = created; }}
    />
  );
  const page = render(live("First paragraph.\n\nSecond paragraph.\n"));
  act(() => { view!.dispatch({ changes: { from: 16, insert: " One" }, userEvent: "input.type" }); });
  // A co-author's words land in the buffer while the writer is still typing:
  // the view waits out the typing before showing them.
  const remote = `${emitted.at(-1)!.replace("Second", "The second")}`;
  outside.add(remote);
  page.rerender(live(remote));
  expect(view!.state.doc.toString()).not.toBe(remote);
  // The next keystroke comes before the view has shown them.
  act(() => { view!.dispatch({ changes: { from: 20, insert: " two" }, userEvent: "input.type" }); });
  const merged = "First paragraph. One two\n\nThe second paragraph.\n";
  expect(emitted.at(-1)).toBe(merged);
  page.rerender(live(merged));
  await act(async () => { await Promise.resolve(); });
  expect(view!.state.doc.toString()).toBe(merged);
  // Undo takes back only the writer's own typing.
  act(() => { undo(view!); });
  expect(view!.state.doc.toString()).toBe("First paragraph.\n\nThe second paragraph.\n");
});
