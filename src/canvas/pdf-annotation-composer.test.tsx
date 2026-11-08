import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationRounds, MappedPdfSelection } from "../app/annotation-rounds";
import type { CommentDestination } from "../app/use-editor-comments";
import type { CommentPlacement } from "../overleaf/use-overleaf-comments";
import { PdfAnnotationComposer } from "./pdf-annotation-composer";

// jsdom lays nothing out, so placed beside its passage the popup would stay
// hidden, and a hidden element has no accessible name to find it by.
vi.mock("../pdf/use-pdf-anchored-popup", () => ({ usePdfAnchoredPopup: () => {} }));

const notify = vi.hoisted(() => ({ showError: vi.fn() }));
vi.mock("../app/notify", () => notify);

beforeEach(() => notify.showError.mockClear());
afterEach(cleanup);

const SELECTION = { page: 1, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }], text: "attention weights", point: { x: 80, y: 160 } };
const MAPPED: MappedPdfSelection = { path: "main_v2.tex", line: 35, from: 10, to: 27, source: "" };

/** The note on a PDF selection SyncTeX places in main_v2.tex, which goes to `destination`. */
function compose(
  destination: CommentDestination,
  placement: () => Promise<CommentPlacement> = async () => "placed",
  outcome: ReturnType<AnnotationRounds["createFromPdf"]> = "saved",
) {
  const now = { destination };
  const rounds = {
    mapPdfSelection: vi.fn(async () => MAPPED),
    pdfNoteDestination: vi.fn(() => now.destination),
    createFromPdf: vi.fn(() => outcome),
    commentInDocumentFromPdf: vi.fn(placement),
    openPdfSource: vi.fn(),
  } as unknown as AnnotationRounds;
  const onDone = vi.fn();
  const onDismiss = vi.fn();
  const { unmount } = render(<PdfAnnotationComposer selection={SELECTION} rounds={rounds} onDone={onDone} onDismiss={onDismiss} />);
  return { rounds, onDone, onDismiss, now, unmount };
}

const button = (name: string) => screen.findByRole("button", { name: new RegExp(name) });

describe("a note made on the PDF of a project linked to Overleaf", () => {
  it("becomes an Overleaf comment on the span SyncTeX found: words alone, no agent revision", async () => {
    const { rounds, onDone } = compose("overleaf");
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    expect(rounds.pdfNoteDestination).toHaveBeenCalledWith("main_v2.tex");
    expect(screen.queryByRole("group", { name: "What the agent should do" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save and revise now/ })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), { target: { value: "Cite the source here." } });
    fireEvent.click(await button("Comment on Overleaf"));
    expect(rounds.createFromPdf).toHaveBeenCalledWith(SELECTION, MAPPED, "Cite the source here.", undefined, false);
    expect(onDone).toHaveBeenCalled();
  });

  it("comments in one step on a passage from a file the editor does not have open", async () => {
    let answer: (placement: CommentPlacement) => void = () => {};
    const { rounds, onDone } = compose("other-file", () => new Promise((resolve) => { answer = resolve; }));
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), { target: { value: "Cite it." } });
    fireEvent.click(await button("Comment on Overleaf"));
    expect(rounds.commentInDocumentFromPdf).toHaveBeenCalledWith(SELECTION, MAPPED, "Cite it.");
    expect(rounds.createFromPdf).not.toHaveBeenCalled();
    // It waits for Overleaf, and Save cannot send it twice meanwhile.
    expect(await button("Comment on Overleaf")).toBeDisabled();
    expect(onDone).not.toHaveBeenCalled();
    answer("placed");
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(rounds.openPdfSource).not.toHaveBeenCalled();
  });

  it("stays open through Esc and a click outside while Overleaf takes the comment", async () => {
    let answer: (placement: CommentPlacement) => void = () => {};
    const { onDone, onDismiss } = compose("other-file", () => new Promise((resolve) => { answer = resolve; }));
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    const field = screen.getByRole("textbox", { name: "Annotation" });
    fireEvent.change(field, { target: { value: "Cite it." } });
    fireEvent.click(await button("Comment on Overleaf"));
    expect(await button("Comment on Overleaf")).toBeDisabled();

    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(onDismiss).not.toHaveBeenCalled();

    answer("placed");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /** Save a note to main_v2.tex, then let a new note replace it before Overleaf answers with `settle`. */
  async function replacedWhileSaving(settle: (answer: { resolve: (p: CommentPlacement) => void; reject: (e: Error) => void }) => void) {
    let answer = { resolve: (_: CommentPlacement) => {}, reject: (_: Error) => {} };
    const composed = compose("other-file", () => new Promise((resolve, reject) => { answer = { resolve, reject }; }));
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), { target: { value: "Cite it." } });
    fireEvent.click(await button("Comment on Overleaf"));
    expect(await button("Comment on Overleaf")).toBeDisabled();
    composed.unmount();
    settle(answer);
    await Promise.resolve();
    await Promise.resolve();
    return composed;
  }

  it("says so, and opens the file, when a note replaced mid-save finds Overleaf's copy differs", async () => {
    const { rounds, onDone } = await replacedWhileSaving(({ resolve }) => resolve("notFound"));
    await waitFor(() => expect(notify.showError).toHaveBeenCalledTimes(1));
    expect(notify.showError.mock.calls[0][0]).toMatch(/main_v2\.tex did not reach Overleaf/);
    expect(rounds.openPdfSource).toHaveBeenCalledWith(MAPPED);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says so when Overleaf refuses a note replaced mid-save", async () => {
    const { rounds, onDone } = await replacedWhileSaving(({ reject }) => reject(new Error("Overleaf did not say whether the edit applied.")));
    await waitFor(() => expect(notify.showError).toHaveBeenCalledTimes(1));
    expect(notify.showError.mock.calls[0][0]).toMatch(/main_v2\.tex did not reach Overleaf: .*Overleaf did not say whether the edit applied/);
    expect(rounds.openPdfSource).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("stays quiet when a note replaced mid-save lands", async () => {
    const { onDone } = await replacedWhileSaving(({ resolve }) => resolve("placed"));
    expect(notify.showError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("is dismissed by Esc, with what was written, before it is saved", async () => {
    const { onDismiss } = compose("other-file");
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    const field = screen.getByRole("textbox", { name: "Annotation" });
    fireEvent.change(field, { target: { value: "Cite it." } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledWith({ body: "Cite it.", intent: undefined });
  });

  it("opens the file at the passage, keeping the note, when Overleaf's copy reads differently there", async () => {
    const { rounds, onDone } = compose("other-file", async () => "notFound");
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), { target: { value: "Cite it." } });
    fireEvent.click(await button("Comment on Overleaf"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Overleaf's copy of main_v2\.tex reads differently here/);
    expect(rounds.openPdfSource).toHaveBeenCalledWith(MAPPED);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Annotation" })).toHaveValue("Cite it.");
    expect(await button("Comment on Overleaf")).toBeEnabled();
  });

  it("keeps the note and says why when Overleaf refuses the comment", async () => {
    const { onDone } = compose("other-file", async () => { throw new Error("Overleaf did not say whether the edit applied."); });
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), { target: { value: "Cite it." } });
    fireEvent.click(await button("Comment on Overleaf"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not say whether the edit applied/);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Annotation" })).toHaveValue("Cite it.");
  });

  it("says why it cannot be posted while nothing is live, rather than failing quietly", async () => {
    const { rounds } = compose("offline");
    expect((await screen.findByRole("alert")).textContent).toMatch(/main_v2\.tex is not being edited live with Overleaf right now/);
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), { target: { value: "Cite it." } });
    expect(await button("Comment on Overleaf")).toBeDisabled();
    expect(rounds.createFromPdf).not.toHaveBeenCalled();
  });

  it("keeps what was typed when the live channel dropped before it was posted", async () => {
    const { rounds, onDone, now } = compose("overleaf");
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), { target: { value: "Cite the source here." } });
    // Nothing re-renders the composer when the channel goes; Save still reads enabled.
    now.destination = "offline";
    fireEvent.click(await button("Comment on Overleaf"));
    expect(rounds.createFromPdf).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toMatch(/main_v2\.tex is not being edited live with Overleaf right now/);
    expect(screen.getByRole("textbox", { name: "Annotation" })).toHaveValue("Cite the source here.");
  });

  it("keeps what was typed, without blaming the PDF, when the note was refused", async () => {
    const { onDone } = compose("annotation", undefined, "refused");
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), { target: { value: "Cite the source here." } });
    fireEvent.click(await button("^Save(?! and)"));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Annotation" })).toHaveValue("Cite the source here.");
  });

  it("stays an annotation, with the agent's revision, in a project that is not linked", async () => {
    compose("annotation");
    await screen.findByText("PDF p.1 → main_v2.tex:35");
    expect(await button("Save and revise now")).toBeTruthy();
    expect(screen.getByRole("group", { name: "What the agent should do" })).toBeTruthy();
  });
});
