import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { latexCommandCompletions, latexCommandHover } from "./latex-command-completions";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

/** `source` with `|` marking the caret. */
function complete(source: string, explicit = false) {
  const pos = source.indexOf("|");
  const state = EditorState.create({ doc: source.replace("|", ""), selection: { anchor: pos } });
  return { state, pos, result: latexCommandCompletions(new CompletionContext(state, pos, explicit)) };
}

const labels = (source: string) => complete(source).result?.options.map((option) => option.label) ?? [];

/** Apply the completion labelled `label` and return the document with `|` at the caret. */
function accept(source: string, label: string): string {
  const { state, pos, result } = complete(source);
  const option = result!.options.find((candidate) => candidate.label === label)!;
  const view = new EditorView({ parent: document.body, state });
  views.push(view);
  if (typeof option.apply === "function") option.apply(view, option as Completion, result!.from, pos);
  else view.dispatch({ changes: { from: result!.from, to: pos, insert: option.apply ?? option.label } });
  const text = view.state.doc.toString();
  const head = view.state.selection.main.head;
  return `${text.slice(0, head)}|${text.slice(head)}`;
}

describe("built-in LaTeX completion", () => {
  it("offers commands after a backslash, and math symbols only inside math", () => {
    expect(labels("\\sec|")).toContain("\\section");
    expect(labels("\\alp|")).not.toContain("\\alpha");
    expect(labels("$x + \\alp|$")).toContain("\\alpha");
    expect(labels("\\begin{equation}\n\\alp|\n\\end{equation}")).toContain("\\alpha");
    expect(complete("plain |").result).toBeNull();
  });

  it("places the caret in the first argument of a command template", () => {
    expect(accept("\\sec|", "\\section")).toBe("\\section{|}");
    expect(accept("$\\fra|$", "\\frac")).toBe("$\\frac{|}{}$");
  });

  it("leaves braces of citations and references to the editor's own brace handling", () => {
    expect(accept("\\cit|", "\\cite")).toBe("\\cite|");
    expect(accept("\\lab|", "\\label")).toBe("\\label|");
  });

  it("completes an environment name and writes its \\end at the line's indent", () => {
    expect(accept("  \\begin{ite|}", "itemize")).toBe("  \\begin{itemize}\n    |\n  \\end{itemize}");
    expect(accept("\\end{ite|", "itemize")).toBe("\\end{itemize}|");
  });

  it("completes package and document class names inside their arguments", () => {
    expect(labels("\\usepackage{ams|}")).toContain("amsmath");
    expect(complete("\\usepackage[utf8]{graphicx,hyp|}").result?.from).toBe("\\usepackage[utf8]{graphicx,".length);
    expect(labels("\\documentclass{|}")).toContain("article");
  });
});

describe("built-in LaTeX hover", () => {
  const hoverText = (source: string) => {
    const pos = source.indexOf("|");
    const tooltip = latexCommandHover(EditorState.create({ doc: source.replace("|", "") }), pos);
    return tooltip ? (tooltip.create().dom.textContent ?? "") : null;
  };

  it("describes a known command or environment", () => {
    expect(hoverText("\\sec|tion{Intro}")).toBe("\\section\nTop-level section heading");
    expect(hoverText("\\begin{ali|gn}")).toBe("align\nMulti-line aligned equations");
    expect(hoverText("\\toprule|")).toBe("\\toprule\nTop table rule · booktabs");
  });

  it("stays quiet for unknown commands and plain text", () => {
    expect(hoverText("\\myMa|cro")).toBeNull();
    expect(hoverText("pl|ain")).toBeNull();
  });
});
