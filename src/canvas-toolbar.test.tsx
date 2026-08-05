import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "./canvas-toolbar";

afterEach(cleanup);

const baseProps = {
  mode: "source" as const,
  setMode: vi.fn(),
  markdown: false,
  html: false,
  activePath: "main.tex",
  activeKind: "document" as const,
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
