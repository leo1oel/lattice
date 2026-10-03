import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickOpenDialog } from "./quick-open-dialog";
import { splitQuickOpenQuery } from "./quick-open-query";

afterEach(cleanup);

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
    expect(screen.getAllByRole("option")).toHaveLength(2);
    screen.getByRole("option", { name: "notes/note-012.md" });
    screen.getByRole("option", { name: "notes/note-120.md" });
    fireEvent.change(search, { target: { value: "ch intro" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    screen.getByRole("option", { name: "chapters/intro.tex" });
  });

  it("opens a file at the line a name:line query asks for", () => {
    const onOpen = vi.fn();
    render(<QuickOpenDialog open paths={["chapters/intro.tex", "main.tex"]} onClose={vi.fn()} onOpen={onOpen} />);
    const search = screen.getByRole("searchbox", { name: "Quick open search" });
    fireEvent.change(search, { target: { value: "intro:120" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("chapters/intro.tex", 120);
    fireEvent.change(search, { target: { value: "main" } });
    fireEvent.click(screen.getByRole("option", { name: "main.tex" }));
    expect(onOpen).toHaveBeenLastCalledWith("main.tex", undefined);
  });

  it.each([
    ["intro.tex:12", { file: "intro.tex", line: 12 }],
    ["intro.tex:12:4", { file: "intro.tex", line: 12 }],
    ["intro.tex:0", { file: "intro.tex:0" }],
    ["c:notes", { file: "c:notes" }],
    ["intro", { file: "intro" }],
  ])("reads %j as %j", (query, expected) => {
    expect(splitQuickOpenQuery(query)).toEqual(expected);
  });
});
