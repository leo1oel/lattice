import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "./canvas-toolbar";

afterEach(cleanup);

const baseProps = {
  mode: "source" as const,
  setMode: vi.fn(),
  supportsDocumentViewModes: true,
  markdown: false,
  html: false,
  activePath: "main.tex",
  activeKind: "document" as const,
  canInsert: true,
  dirty: false,
  canNavigateBack: false,
  canNavigateForward: false,
  onNavigateBack: vi.fn(),
  onNavigateForward: vi.fn(),
  onInsert: vi.fn(),
  onCollab: vi.fn(),
  collabLive: false,
  collabPeers: 0,
  onHistory: vi.fn(),
  onGit: vi.fn(),
  commentCount: 0,
  onComments: vi.fn(),
};

describe("CanvasToolbar Overleaf status", () => {
  it("shows a non-layout-shifting online dot for live editing and active syncs", () => {
    const { rerender } = render(
      <CanvasToolbar {...baseProps} overleafLinked overleafChannel="live" onOverleafSync={vi.fn()} />,
    );

    let button = screen.getByRole("button", { name: /Connected live/ });
    expect(button.querySelector(".overleaf-status-dot")).not.toBeNull();
    expect(button.querySelector(".animated-product-icon--cloud-upload-outline")?.parentElement).toBe(button);

    rerender(
      <CanvasToolbar {...baseProps} overleafLinked overleafSyncing onOverleafSync={vi.fn()} />,
    );

    button = screen.getByRole("button", { name: "Syncing with Overleaf…" });
    expect(button).toBeDisabled();
    expect(button.querySelector(".overleaf-status-dot")).not.toBeNull();
  });

  it("does not claim an idle manual connection is online", () => {
    render(
      <CanvasToolbar {...baseProps} overleafLinked overleafChannel="off" onOverleafSync={vi.fn()} />,
    );

    const button = screen.getByRole("button", { name: "Sync with Overleaf" });
    expect(button.querySelector(".overleaf-status-dot")).toBeNull();
  });
});

describe("CanvasToolbar insert action", () => {
  it("only renders the action when the active editor supports snippets", () => {
    const { rerender } = render(<CanvasToolbar {...baseProps} />);
    expect(screen.getByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" })).toBeInTheDocument();

    rerender(<CanvasToolbar {...baseProps} activePath="sketch.tldr" canInsert={false} />);
    expect(screen.queryByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" })).not.toBeInTheDocument();
  });
});

describe("CanvasToolbar document views", () => {
  it("presents two editable panes as Edit rather than source-and-preview Split", () => {
    render(<CanvasToolbar {...baseProps} mode="dual" />);
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "false");
  });

  it("replaces unsupported file view modes with one split action", () => {
    const onSplit = vi.fn();
    const { rerender } = render(<CanvasToolbar {...baseProps} />);
    expect(screen.getByRole("tablist", { name: "Document view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split editor right" })).not.toBeInTheDocument();

    rerender(
      <CanvasToolbar
        {...baseProps}
        activePath="references.bib"
        supportsDocumentViewModes={false}
        onSplit={onSplit}
      />,
    );
    expect(screen.queryByRole("tablist", { name: "Document view" })).not.toBeInTheDocument();
    const split = screen.getByRole("button", { name: "Split editor right" });
    expect(split).toBe(screen.getByRole("button", { name: "Go forward (⌘])" }).nextElementSibling);
    expect(split.textContent).toBe("");
    expect(split.querySelector(".lucide-columns-2")).not.toBeNull();
    fireEvent.click(split);
    expect(onSplit).toHaveBeenCalledTimes(1);
  });
});

describe("CanvasToolbar collaboration status", () => {
  it("shows the live peer count in the collaboration-specific badge", () => {
    render(
      <CanvasToolbar
        {...baseProps}
        collabLive
        collabPeers={2}
        collabPresence={<div aria-label="Collaboration avatars" />}
      />,
    );

    const button = screen.getByRole("button", { name: "Live · 2 others" });
    const badge = button.querySelector(".collab-live-badge");
    expect(badge).toHaveTextContent("2");
    expect(badge).toHaveClass("collab-peer-badge");
    expect(screen.getByLabelText("Collaboration avatars").previousElementSibling).toBe(button);
  });
});
