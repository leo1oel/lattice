import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "./canvas-toolbar";

afterEach(cleanup);

const baseProps = {
  activePath: "main.tex", activeKind: "document" as const, dirty: false, commentCount: 0,
  onHistory: vi.fn(), onGit: vi.fn(), onComments: vi.fn(),
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

describe("CanvasToolbar project tools", () => {
  it("leaves document views, splits and insert palettes to the document panels", () => {
    render(<CanvasToolbar {...baseProps} />);
    expect(screen.queryByRole("tablist", { name: "Document view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split editor right" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Insert snippet/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go back (⌘[)" })).not.toBeInTheDocument();
  });

  it("hides the tools the writer turned off in Settings", () => {
    const { rerender } = render(<CanvasToolbar {...baseProps} onPaperLookup={vi.fn()} />);
    for (const name of ["Editor comments", "Paper lookup", "Git status and commit", "Project history"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    rerender(<CanvasToolbar {...baseProps} onPaperLookup={vi.fn()} hiddenTools={["comments", "history"]} />);
    expect(screen.queryByRole("button", { name: "Editor comments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Project history" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Git status and commit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paper lookup" })).toBeInTheDocument();
  });
});
