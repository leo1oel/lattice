import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { Tooltip } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { latexCommandHover } from "../editor/latex/latex-command-completions";
import { isCiteOrRefCompletionContext, texlabCompletionSource, texlabHover } from "./texlab-language";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

describe("isCiteOrRefCompletionContext", () => {
  it("detects citation and reference argument contexts", () => {
    expect(isCiteOrRefCompletionContext("see \\cite{vas")).toBe(true);
    expect(isCiteOrRefCompletionContext("see \\ref{fig:")).toBe(true);
    expect(isCiteOrRefCompletionContext("\\usepackage{ams")).toBe(false);
    expect(isCiteOrRefCompletionContext("\\begin{eq")).toBe(false);
  });
});

describe("texlabCompletionSource", () => {
  const sentTexts = () => invokeMock.mock.calls.map(([, args]) => (args as { text: string | null }).text);
  const complete = (state: EditorState, path = "paper.tex") => (
    texlabCompletionSource(() => path)(new CompletionContext(state, state.doc.length, true))
  );

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([{ label: "\\section" }]);
  });

  it("sends the text once per revision, then only the position", async () => {
    const state = EditorState.create({ doc: "Intro \\sec" });
    await complete(state);
    await complete(state);
    const edited = state.update({ changes: { from: state.doc.length, insert: "t" } }).state;
    await complete(edited);
    expect(sentTexts()).toEqual(["Intro \\sec", null, "Intro \\sect"]);
    const revisions = invokeMock.mock.calls.map(([, args]) => (args as { revision: number }).revision);
    expect(revisions[1]).toBe(revisions[0]);
    expect(revisions[2]).not.toBe(revisions[0]);
  });

  it("sends the text again when TexLab no longer holds that revision", async () => {
    const state = EditorState.create({ doc: "\\beg" });
    await complete(state, "resync.tex");
    invokeMock.mockRejectedValueOnce("TexLab needs the document text.");
    const result = await complete(state, "resync.tex");
    expect(sentTexts()).toEqual(["\\beg", null, "\\beg"]);
    expect(result?.options.map((option) => option.label)).toEqual(["\\section"]);
  });

  it("gives no answer, without resending, when TexLab fails otherwise", async () => {
    const state = EditorState.create({ doc: "\\end" });
    await complete(state, "failing.tex");
    invokeMock.mockRejectedValueOnce("TexLab read timed out.");
    expect(await complete(state, "failing.tex")).toBeNull();
    expect(sentTexts()).toEqual(["\\end", null]);
  });
});

describe("texlabHover", () => {
  const description = (tooltip: Tooltip | null) => tooltip && (tooltip.create(null as never).dom.textContent ?? "");
  const hoverAt = (source: string, texlab: boolean) => {
    const pos = source.indexOf("|");
    const state = EditorState.create({ doc: source.replace("|", "") });
    return texlabHover(() => "paper.tex", latexCommandHover, texlab)(state, pos).then(description);
  };

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ contents: "TexLab says" });
  });

  it("gives a command inside math no description, from TexLab or the built-in vocabulary", async () => {
    for (const texlab of [true, false]) {
      expect(await hoverAt("Let $n \\ti|mes n$ be", texlab)).toBeNull();
      expect(await hoverAt("\\[ a \\ti|mes b \\]", texlab)).toBeNull();
      expect(await hoverAt("\\begin{align}\n  a &= b \\ti|mes c\n\\end{align}", texlab)).toBeNull();
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("still describes the same command outside math, and a math environment's own delimiter", async () => {
    expect(await hoverAt("text \\ti|mes text", true)).toBe("TexLab says");
    expect(await hoverAt("\\sec|tion{Intro} $n$", false)).toBe("\\section\nTop-level section heading");
    expect(await hoverAt("\\begin{ali|gn}\n  a = b\n\\end{align}", false)).toBe("align\nMulti-line aligned equations");
  });
});
