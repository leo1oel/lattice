import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickOpenDialog } from "./quick-open-dialog";

describe("QuickOpenDialog intent", () => {
  it("previews the highlighted result without opening it", async () => {
    const onIntent = vi.fn();
    const onOpen = vi.fn();

    render(
      <QuickOpenDialog
        open
        paths={["notes/alpha.md", "notes/beta.md"]}
        onClose={vi.fn()}
        onOpen={onOpen}
        onIntent={onIntent}
      />,
    );

    await waitFor(() => expect(onIntent).toHaveBeenLastCalledWith("notes/alpha.md"));
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Quick open search" }), {
      key: "ArrowDown",
    });
    await waitFor(() => expect(onIntent).toHaveBeenLastCalledWith("notes/beta.md"));

    fireEvent.mouseEnter(screen.getByRole("option", { name: "notes/alpha.md" }));
    await waitFor(() => expect(onIntent).toHaveBeenLastCalledWith("notes/alpha.md"));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
