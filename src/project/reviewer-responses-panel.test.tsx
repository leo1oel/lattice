import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { annotationRounds, type AnnotationRoundsDeps } from "../app/annotation-rounds";
import { reviewerResponses, type ReviewerResponsesDeps } from "../app/reviewer-responses";
import { createEditorComment, type EditorComment } from "../editor/comments/editor-comment-data";
import { ReviewerResponsesPanel } from "./reviewer-responses-panel";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: tauri.save }));

const SOURCE = "\\section{Method}\nWe now report latency on GPUs.\n";
const PASTE = [
  "Reviewer 1",
  "1. No latency numbers.",
  "2. Typo in Eq. 3.",
  "",
  "Reviewer 2",
  "Summary: a sparse attention scheme.",
  "",
  "How is k chosen?",
].join("\n");

let stored: unknown;
let annotations: EditorComment[];

beforeEach(() => {
  stored = null;
  const from = SOURCE.indexOf("We now");
  annotations = [{
    ...createEditorComment({ path: "main.tex", source: SOURCE, from, to: from + 30, body: "latency", authorId: "me", authorName: "Ada" })!,
    number: 4,
  }];
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "read_reviewer_responses") return stored;
    if (command === "save_reviewer_responses") stored = args?.responses;
    if (command === "read_project_file") return SOURCE;
    return null;
  });
  // Linked passages are read where a revision round reads them.
  annotationRounds.attach({
    store: { stateRef: { current: { annotations, rounds: [] } } },
    projectRootRef: { current: "/p" },
    activeFileRef: { current: "" },
    sourceRef: { current: "" },
  } as unknown as AnnotationRoundsDeps);
  reviewerResponses.reset();
  reviewerResponses.attach({
    store: { stateRef: { current: { annotations, rounds: [] } }, openComment: vi.fn() } as unknown as ReviewerResponsesDeps["store"],
    projectRootRef: { current: "/p" },
  });
});
afterEach(() => {
  cleanup();
  reviewerResponses.reset();
});

describe("ReviewerResponsesPanel", () => {
  it("numbers pasted comments by reviewer, leaving out the summary until asked", async () => {
    render(<ReviewerResponsesPanel annotations={annotations} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Paste reviews" }));
    fireEvent.change(screen.getByLabelText("Paste the reviews"), { target: { value: PASTE } });
    expect(screen.getByText("R1.1")).toBeTruthy();
    expect(screen.getByText("R1.2")).toBeTruthy();
    // The summary is proposed as left out, so the question is R2.1.
    expect(screen.getByText("R2.1").parentElement?.textContent).toContain("How is k chosen?");
    fireEvent.click(screen.getByRole("button", { name: "Add 3 comments" }));

    expect(screen.getByText("0 of 3 answered")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Reviewer 2/ })).toBeTruthy();
  });

  it("keeps the reply's check apart from the change, and links a passage that changed", async () => {
    render(<ReviewerResponsesPanel annotations={annotations} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Paste reviews" }));
    fireEvent.change(screen.getByLabelText("Paste the reviews"), { target: { value: "Add latency numbers." } });
    fireEvent.click(screen.getByRole("button", { name: "Add 1 comment" }));
    fireEvent.click(screen.getByRole("button", { name: /R1\.1/ }));

    const checked = screen.getByRole("checkbox", { name: "Reply checked against the paper" }) as HTMLInputElement;
    expect(checked.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("What you tell the reviewer"), { target: { value: "Added in §4." } });
    fireEvent.click(checked);
    expect(screen.getByText("1 of 1 answered")).toBeTruthy();
    expect(screen.getByText("1 change to make")).toBeTruthy();

    act(() => reviewerResponses.link(reviewerResponses.getSnapshot().responses.comments[0].id, 4));
    await waitFor(() => expect(screen.getByText("main.tex:2")).toBeTruthy());
    expect(screen.getByText("We now report latency on GPUs.")).toBeTruthy();
  });

  it("reopens on what was saved", async () => {
    stored = {
      version: 1, reviewers: { 1: "xK7p" }, last: { 1: 2 },
      comments: [{ id: "a", reviewer: 1, number: 2, comment: "Why k?", owner: "Ada", reply: "", replyChecked: false, change: "none", annotations: [] }],
    };
    render(<ReviewerResponsesPanel annotations={annotations} onClose={() => {}} />);
    expect(await screen.findByText("R1.2")).toBeTruthy();
    expect(screen.getByText("Reviewer 1 · xK7p")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
  });
});
