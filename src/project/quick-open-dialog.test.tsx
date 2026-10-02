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

  it("matches the parts of a spaced query in order", () => {
    render(
      <QuickOpenDialog open paths={["notes/note-012.md", "chapters/intro.tex", "notes/note-120.md"]} onClose={vi.fn()} onOpen={vi.fn()} />,
    );
    const search = screen.getByRole("searchbox", { name: "Quick open search" });
    fireEvent.change(search, { target: { value: "note 12" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent).sort()).toEqual(["notes/note-012.md", "notes/note-120.md"]);
    fireEvent.change(search, { target: { value: "ch intro" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["chapters/intro.tex"]);
  });
});
