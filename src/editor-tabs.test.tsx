import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorTabs } from "./editor-tabs";

afterEach(() => {
  cleanup();
});

describe("EditorTabs", () => {
  it("selects a tab on click", () => {
    const onSelect = vi.fn();
    render(
      <EditorTabs
        tabs={[
          { path: "main.tex" },
          { path: "sections/intro.tex" },
        ]}
        activePath="main.tex"
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /intro\.tex/i }));
    expect(onSelect).toHaveBeenCalledWith("sections/intro.tex");
  });

  it("closes from the context menu", () => {
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={[
          { path: "main.tex" },
          { path: "sections/intro.tex" },
        ]}
        activePath="main.tex"
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />,
    );
    const introTab = screen.getByRole("tab", { name: /intro\.tex/i }).closest(".editor-tab");
    fireEvent.contextMenu(introTab as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledWith("sections/intro.tex");
  });
});
