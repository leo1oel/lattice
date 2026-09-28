import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "./canvas-toolbar";

afterEach(cleanup);

const baseProps = {
  mode: "source" as const, activePath: "main.tex", activeKind: "document" as const, supportsDocumentViewModes: true, canInsert: true,
  markdown: false, html: false, dirty: false, collabLive: false, collabPeers: 0, commentCount: 0,
  setMode: vi.fn(), onInsert: vi.fn(), onCollab: vi.fn(), onHistory: vi.fn(), onGit: vi.fn(), onComments: vi.fn(),
};
const openOverleafActions = () => fireEvent.pointerDown(
  screen.getByRole("button", { name: "Overleaf project actions" }),
  { button: 0, pointerType: "mouse" },
);

describe("CanvasToolbar Overleaf status", () => {
  it("offers one comment entry for linked projects and keeps local projects' entry", () => {
    const onOverleafChat = vi.fn();
    const { rerender } = render(<CanvasToolbar {...baseProps} overleafLinked onOverleafChat={onOverleafChat} overleafUnreadChat={3} />);
    expect(screen.queryByRole("button", { name: "Editor comments" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Overleaf comments and chat · 3 waiting" }));
    expect(onOverleafChat).toHaveBeenCalledOnce();
    rerender(<CanvasToolbar {...baseProps} commentCount={2} />);
    expect(screen.getByRole("button", { name: "Editor comments" })).toHaveTextContent("2");
    expect(screen.queryByRole("button", { name: /Overleaf comments and chat/ })).not.toBeInTheDocument();
  });

  it("keeps sync primary while exposing the current and other Overleaf projects", async () => {
    const onSync = vi.fn();
    const onOpenCurrent = vi.fn();
    const onOpenOther = vi.fn();
    render(<CanvasToolbar
      {...baseProps} overleafLinked overleafProjectName="Attention Paper"
      onOverleafSync={onSync} onOverleafOpenCurrent={onOpenCurrent} onOverleafOpen={onOpenOther}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Sync with Overleaf" }));
    expect(onSync).toHaveBeenCalledOnce();

    for (const [name, handler] of [["Open in Overleaf", onOpenCurrent], ["Open another Overleaf project", onOpenOther]] as const) {
      openOverleafActions();
      expect(await screen.findByText("Attention Paper")).toBeInTheDocument();
      const item = screen.getByRole("menuitem", { name });
      expect(item).toHaveClass("overleaf-toolbar-menu-item");
      fireEvent.click(item);
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  it.each([
    // The dot is non-layout-shifting: it marks live editing and active syncs,
    // but never an idle manual connection.
    { state: { overleafChannel: "live" }, name: /Connected live/, online: true, disabled: false },
    { state: { overleafSyncing: true }, name: "Syncing with Overleaf…", online: true, disabled: true },
    { state: { overleafChannel: "off" }, name: "Sync with Overleaf", online: false, disabled: false },
  ] as const)("shows the online dot for $name: $online", ({ state, name, online, disabled }) => {
    render(<CanvasToolbar {...baseProps} overleafLinked {...state} onOverleafSync={vi.fn()} />);

    const button = screen.getByRole<HTMLButtonElement>("button", { name });
    expect(Boolean(button.querySelector(".overleaf-status-dot"))).toBe(online);
    expect(button.disabled).toBe(disabled);
    if (!disabled) expect(button.querySelector(".animated-product-icon--cloud-upload-outline")?.closest("button")).toBe(button);
  });
});

describe("CanvasToolbar document views", () => {
  it("renders the insert action only for editors with snippets, and no file navigation", () => {
    const { rerender } = render(<CanvasToolbar {...baseProps} />);
    expect(screen.getByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go back (⌘[)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go forward (⌘])" })).not.toBeInTheDocument();

    rerender(<CanvasToolbar {...baseProps} activePath="sketch.tldr" canInsert={false} />);
    expect(screen.queryByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" })).not.toBeInTheDocument();
  });

  it("presents two editable panes as Edit rather than source-and-preview Split, with an explicit close", () => {
    const onCloseSplit = vi.fn();
    render(<CanvasToolbar {...baseProps} mode="dual" onCloseSplit={onCloseSplit} />);
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByRole("button", { name: "Close split" }));
    expect(onCloseSplit).toHaveBeenCalledOnce();
  });

  it("replaces unsupported file view modes with one split action", () => {
    const onSplit = vi.fn();
    const { rerender } = render(<CanvasToolbar {...baseProps} />);
    expect(screen.getByRole("tablist", { name: "Document view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split editor right" })).not.toBeInTheDocument();

    rerender(<CanvasToolbar {...baseProps} activePath="references.bib" supportsDocumentViewModes={false} onSplit={onSplit} />);
    expect(screen.queryByRole("tablist", { name: "Document view" })).not.toBeInTheDocument();
    const split = screen.getByRole("button", { name: "Split editor right" });
    expect(split).toBe(split.closest(".canvas-actions")?.firstElementChild);
    expect(split.textContent).toBe("");
    expect(split.querySelector(".lucide-columns-2")).not.toBeNull();
    fireEvent.click(split);
    expect(onSplit).toHaveBeenCalledTimes(1);
  });

});

describe("CanvasToolbar collaboration status", () => {
  it("shows the live peer count in the collaboration-specific badge", () => {
    render(<CanvasToolbar {...baseProps} collabLive collabPeers={2} collabPresence={<div aria-label="Collaboration avatars" />} />);
    const button = screen.getByRole("button", { name: "Live · 2 others" });
    const badge = button.querySelector(".collab-live-badge");
    expect(badge).toHaveTextContent("2");
    expect(badge).toHaveClass("collab-peer-badge");
    expect(screen.getByLabelText("Collaboration avatars").previousElementSibling).toBe(button);
  });
});
