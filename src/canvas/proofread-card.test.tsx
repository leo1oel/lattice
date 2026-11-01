import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProofreadAsk } from "../agent/agent-proofread";
import { ProofreadCard, type ProofreadCardState } from "./proofread-card";

afterEach(cleanup);

function renderCard(ask: ProofreadAsk, state: ProofreadCardState, original = "我们提出一种方法。") {
  const handlers = {
    onAccept: vi.fn(), onAcceptAll: vi.fn(), onDismiss: vi.fn(), onRetry: vi.fn(), onMode: vi.fn(), onChoose: vi.fn(),
  };
  render(<ProofreadCard original={original} ask={ask} state={state} editable {...handlers} />);
  return handlers;
}

describe("ProofreadCard", () => {
  it("names a rewrite by the writer's instruction instead of offering the strengths", () => {
    renderCard({ instruction: "Translate into academic English" }, { status: "loading" });
    const card = screen.getByRole("group", { name: "Rewrite suggestion" });
    expect(card).toHaveAttribute("data-mode", "custom");
    expect(screen.getByText("Translate into academic English")).toHaveAttribute("title", "Translate into academic English");
    expect(screen.queryByRole("tablist", { name: "Editing strength" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Rewriting…");
  });

  it("offers a translation as one reviewable edit tagged as one", () => {
    const original = "我们提出一种方法。";
    const { onAccept } = renderCard({ instruction: "Translate into academic English" }, {
      status: "ready",
      review: {
        edits: [{ id: 0, from: 0, to: original.length, insert: "We propose a method.", reason: { category: "translation", note: "" } }],
        held: [],
      },
      rejected: new Set(),
    }, original);
    expect(screen.getByText("translation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("says a failed rewrite could not rewrite", () => {
    renderCard({ instruction: "Shorten" }, { status: "error", message: "The agent could not rewrite the selection.", retryable: true });
    expect(screen.getByRole("status")).toHaveTextContent("Could not rewrite");
  });

  it("keeps the strength switch for Proofread and Polish", () => {
    const { onMode } = renderCard("proofread", { status: "loading" }, "Text.");
    expect(screen.getByRole("group", { name: "Proofread suggestion" })).toHaveAttribute("data-mode", "proofread");
    fireEvent.click(screen.getByRole("tab", { name: "Polish" }));
    expect(onMode).toHaveBeenCalledWith("polish");
  });
});
