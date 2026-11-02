import { act, cleanup, render, screen } from "@testing-library/react";
import { redo, undo } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import { CodeMirrorHost } from "./codemirror-host";
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
