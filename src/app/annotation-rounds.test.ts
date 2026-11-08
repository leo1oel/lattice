import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviseAnnotationWithAgent } from "../agent/agent-annotations";
import { annotateSelection } from "../canvas/annotate-selection";
import { createEditorComment, type AnnotationIntent, type AnnotationRound, type EditorComment } from "../editor/comments/editor-comment-data";
import { sourceRangeForPdfText } from "../editor/comments/pdf-source-anchor";
import { getStartedProgress } from "../onboarding/get-started-progress";
import { AnnotationRounds, type AnnotationRoundsDeps } from "./annotation-rounds";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../agent/agent-annotations", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent/agent-annotations")>(),
  reviseAnnotationWithAgent: vi.fn(),
}));

const SOURCE = [
  "We evaluate the method on three very large benchmarks in order to be thorough.",
  "The results show that the approach is deliberately simple and very effective.",
  "Training takes a lot of time due to the fact that the data is large.",
].join("\n");

const passage = (index: number) => SOURCE.split("\n")[index]!;

/** An open annotation on line `index` of SOURCE, as the store saves one. */
function annotationOn(index: number, number: number, intent: AnnotationIntent): EditorComment {
  const from = SOURCE.indexOf(passage(index));
  return {
    ...createEditorComment({ path: "main.tex", source: SOURCE, from, to: from + passage(index).length, body: "", intent, authorId: "ada", authorName: "Ada" })!,
    number,
  };
}

/** Rounds over an in-memory store holding `annotations`, with an agent that answers every passage at once. */
function roundsWith(annotations: EditorComment[]) {
  const state = { current: { annotations, rounds: [] as AnnotationRound[] } };
  const store: AnnotationRoundsDeps["store"] = {
    stateRef: state,
    commit: (change) => {
      state.current = change(state.current);
      return true;
    },
    create: (comment) => {
      const created = { ...comment, number: state.current.annotations.length + 1 };
      state.current = { ...state.current, annotations: [...state.current.annotations, created] };
      return created;
    },
    createInDocument: vi.fn(async () => "placed" as const),
    destination: () => "annotation", setActiveId: vi.fn(), openComment: vi.fn(), resolve: vi.fn(), reply: vi.fn(),
  };
  const rounds = new AnnotationRounds();
  const sourceRef = { current: SOURCE };
  rounds.attach({
    store, projectRootRef: { current: "/paper" }, activeFileRef: { current: "main.tex" }, sourceRef,
    openProjectFile: vi.fn(), author: { id: "ada", name: "Ada" }, openPanel: vi.fn(),
    openHistoryEntry: vi.fn(), save: vi.fn(async () => true), reloadAfterRestore: vi.fn(async () => {}),
  });
  /** The passages the agent was asked to revise, once every task has answered. */
  const asked = async () => {
    await vi.waitFor(() => expect(rounds.getSnapshot().running.size).toBe(0));
    return vi.mocked(reviseAnnotationWithAgent).mock.calls.map(([request]) => request.passage);
  };
  const proposed = () => state.current.annotations.filter((annotation) => annotation.revision?.state === "proposed").map((annotation) => annotation.quote);
  return { rounds, store, sourceRef, asked, proposed };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => command === "read_annotation_round" ? [] : null);
  vi.mocked(reviseAnnotationWithAgent).mockReset().mockImplementation(async ({ passage }) => ({
    kind: "revision", text: passage.replace(/\bvery\b\s*/g, ""), reason: "Shorter.",
  }));
});

describe("AnnotationRounds / PDF notes posted to Overleaf", () => {
  // Overleaf anchors a comment by offset in the live document, which a
  // collaborator may have changed since the passage was selected on the PDF.
  function overleafNote(live: string) {
    const { rounds, store, sourceRef } = roundsWith([]);
    const create = vi.fn((): "overleaf" => "overleaf");
    Object.assign(store, { destination: () => "overleaf", create });
    sourceRef.current = live;
    // As mapPdfSelection placed it when the PDF text was selected.
    const { from, to } = sourceRangeForPdfText(SOURCE, 2, passage(1))!;
    const mapped = { path: "main.tex", line: 2, from, to, source: SOURCE };
    const selection = { page: 1, rects: [], text: passage(1), point: { x: 0, y: 0 } };
    const saved = rounds.createFromPdf(selection, mapped, "Cite this.", undefined, false);
    return { saved, create, from, quote: SOURCE.slice(from, to) };
  }

  it("anchors the comment where the passage stands in the live text now", () => {
    const added = "A collaborator wrote this line above.\n";
    const { saved, create, from, quote } = overleafNote(added + SOURCE);
    expect(saved).toBe("saved");
    const [comment] = create.mock.calls[0] as unknown as [EditorComment];
    expect(comment.from).toBe(added.length + from);
    expect(comment.quote).toBe(quote);
  });

  it("posts nothing when the passage itself changed since the PDF was built", () => {
    const { saved, create } = overleafNote(SOURCE.replace("deliberately simple", "simple"));
    expect(saved).toBe("stale");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("AnnotationRounds / PDF notes on a file the editor does not have open", () => {
  const ABSTRACT = "\\begin{abstract}\nWe show that it works.\nWe show that it scales.\n\\end{abstract}\n";

  it("maps the selection into that file and comments on the exact span, without opening it", async () => {
    const { rounds, store } = roundsWith([]);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "synctex_edit") return { path: "abstract.tex", line: 3 };
      if (command === "read_project_file") return (args as { path: string }).path === "abstract.tex" ? ABSTRACT : null;
      return null;
    });
    const selection = { page: 1, rects: [], text: "it scales", point: { x: 0, y: 0 } };
    const mapped = await rounds.mapPdfSelection(selection);
    // The second "We show that it", on the line SyncTeX named: not the first.
    const from = ABSTRACT.indexOf("it scales");
    expect(mapped).toEqual({ path: "abstract.tex", line: 3, from, to: from + "it scales".length, source: ABSTRACT });

    await expect(rounds.commentInDocumentFromPdf(selection, mapped, " Cite it. ")).resolves.toBe("placed");
    const [comment, source] = vi.mocked(store.createInDocument).mock.calls[0]!;
    expect(source).toBe(ABSTRACT);
    expect(comment).toMatchObject({ path: "abstract.tex", from, to: from + 9, quote: "it scales", body: "Cite it." });
    expect((rounds as unknown as { deps: AnnotationRoundsDeps }).deps.openProjectFile).not.toHaveBeenCalled();
  });

  it("opens the file beside the PDF at the passage when asked to place it there", () => {
    const { rounds } = roundsWith([]);
    const deps = (rounds as unknown as { deps: AnnotationRoundsDeps }).deps;
    rounds.openPdfSource({ path: "abstract.tex", line: 3, from: 0, to: 1, source: ABSTRACT });
    expect(deps.openProjectFile).toHaveBeenCalledWith("abstract.tex", { line: 3, revealSource: false });
  });
});

describe("AnnotationRounds / revise scope", () => {
  // The captain's case: two notes are open, the writer selects a third passage,
  // picks Shorten and saves with Save and revise now. Only that passage changes.
  it("revises only the source note saved with Save and revise now, not every open annotation", async () => {
    const { rounds, store, asked, proposed } = roundsWith([annotationOn(0, 1, "rewrite"), annotationOn(1, 2, "clarify")]);
    const from = SOURCE.indexOf(passage(2));
    const review = { commentAuthorId: "ada", commentAuthorName: "Ada", onCreateEditorComment: store.create, annotationRounds: rounds };

    expect(annotateSelection(review, {
      path: "main.tex", source: SOURCE, from, to: from + passage(2).length, body: "", intent: "shorten", revise: true,
    })).toBe(true);

    expect(await asked()).toEqual([passage(2)]);
    expect(proposed()).toEqual([passage(2)]);
  });

  it("revises only the PDF note saved with Save and revise now", async () => {
    const { rounds, asked, proposed } = roundsWith([annotationOn(0, 1, "rewrite"), annotationOn(1, 2, "clarify")]);
    const from = SOURCE.indexOf(passage(2));
    const mapped = { path: "main.tex", line: 3, from, to: from + passage(2).length, source: SOURCE };
    const selection = { page: 1, rects: [], text: passage(2), point: { x: 0, y: 0 } };

    expect(rounds.createFromPdf(selection, mapped, "", "shorten", true)).toBe("saved");

    expect(await asked()).toEqual([passage(2)]);
    expect(proposed()).toEqual([passage(2)]);
  });

  // A store that refuses the note (annotations not read yet) must not read as
  // saved, or the composer closes and the typed note is lost.
  it("reports a refused note as not made, from the source or the PDF, and asks the agent nothing", async () => {
    const { rounds, store } = roundsWith([]);
    Object.assign(store, { create: () => null });
    const from = SOURCE.indexOf(passage(2));
    const review = { commentAuthorId: "ada", commentAuthorName: "Ada", onCreateEditorComment: store.create, annotationRounds: rounds };
    const mapped = { path: "main.tex", line: 3, from, to: from + passage(2).length, source: SOURCE };
    const selection = { page: 1, rects: [], text: passage(2), point: { x: 0, y: 0 } };

    expect(annotateSelection(review, { path: "main.tex", source: SOURCE, from, to: mapped.to, body: "Tighten", revise: true })).toBe(false);
    expect(rounds.createFromPdf(selection, mapped, "Tighten", undefined, true)).toBe("refused");
    expect(reviseAnnotationWithAgent).not.toHaveBeenCalled();
  });

  it("counts an Annotate answer as the Get started Agent step done, and a failed one not", async () => {
    localStorage.clear();
    vi.mocked(reviseAnnotationWithAgent).mockRejectedValueOnce(new Error("no provider"));
    const first = roundsWith([annotationOn(0, 1, "rewrite")]);
    first.rounds.revise("open");
    await first.asked();
    expect(getStartedProgress.get().done).not.toContain("agent");

    const second = roundsWith([annotationOn(1, 1, "shorten")]);
    second.rounds.revise("open");
    await second.asked();
    expect(getStartedProgress.get().done).toContain("agent");
    localStorage.clear();
  });

  it("revises every open annotation from the panel's Revise", async () => {
    const { rounds, asked } = roundsWith([annotationOn(0, 1, "rewrite"), annotationOn(1, 2, "shorten")]);

    rounds.revise("open");

    expect((await asked()).sort()).toEqual([passage(0), passage(1)].sort());
  });

  it("revises only the annotations it names", async () => {
    const annotations = [annotationOn(0, 1, "rewrite"), annotationOn(1, 2, "shorten"), annotationOn(2, 3, "clarify")];
    const { rounds, asked } = roundsWith(annotations);

    rounds.revise([annotations[1]!.id]);

    expect(await asked()).toEqual([passage(1)]);
  });
});
