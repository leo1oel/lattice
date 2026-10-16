import { cleanup, render, screen } from "@testing-library/react";
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
