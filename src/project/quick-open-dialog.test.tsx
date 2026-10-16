import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickOpenDialog } from "./quick-open-dialog";

afterEach(cleanup);

function renderQuickOpen(props: Partial<ComponentProps<typeof QuickOpenDialog>> = {}) {
  const handlers = { onOpen: vi.fn(), onSymbol: vi.fn(), onLine: vi.fn(), onClose: vi.fn() };
  render(
    <QuickOpenDialog
      open
      paths={["notes/alpha.md", "notes/beta.md"]}
      recent={[]}
      current=""
      symbols={() => []}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, search: screen.getByRole("searchbox", { name: "Quick open search" }) };
}

const optionNames = () => screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"));

describe("QuickOpenDialog intent", () => {
  it("previews the highlighted result without opening it", async () => {
    const onIntent = vi.fn();
    const { onOpen, search } = renderQuickOpen({ onIntent });

    await waitFor(() => expect(onIntent).toHaveBeenLastCalledWith("notes/alpha.md"));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    await waitFor(() => expect(onIntent).toHaveBeenLastCalledWith("notes/beta.md"));

    fireEvent.mouseMove(screen.getByRole("option", { name: "notes/alpha.md" }), { clientX: 40, clientY: 20 });
    await waitFor(() => expect(onIntent).toHaveBeenLastCalledWith("notes/alpha.md"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("matches the parts of a spaced query in order", () => {
    const { search } = renderQuickOpen({ paths: ["notes/note-012.md", "chapters/intro.tex", "notes/note-120.md"] });
    fireEvent.change(search, { target: { value: "note 12" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    screen.getByRole("option", { name: "notes/note-012.md" });
    screen.getByRole("option", { name: "notes/note-120.md" });
    fireEvent.change(search, { target: { value: "ch intro" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    screen.getByRole("option", { name: "chapters/intro.tex" });
  });
});

describe("QuickOpenDialog recents", () => {
  const paths = ["main.tex", "sections/intro.tex", "sections/method.tex", "refs.bib", "gone.tex"];

  it("lists the files visited before the rest, newest first, leaving out the one on screen", () => {
    const { search, onOpen } = renderQuickOpen({
      paths: paths.filter((path) => path !== "gone.tex"),
      recent: ["sections/method.tex", "main.tex", "gone.tex", "refs.bib"],
      current: "main.tex",
    });
    expect(optionNames()).toEqual(["sections/method.tex", "refs.bib", "main.tex", "sections/intro.tex"]);
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getByText("All files")).toBeTruthy();
    expect(screen.getByRole("option", { name: "main.tex" }).textContent).toContain("Current");
    // ⌘P ↩ goes back to the file before this one.
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("sections/method.tex", undefined);
  });

  it("ranks a recent file above an equal match and marks the typed characters", () => {
    const { search } = renderQuickOpen({ paths, recent: ["sections/method.tex"] });
    fireEvent.change(search, { target: { value: "sections" } });
    expect(optionNames().slice(0, 2)).toEqual(["sections/method.tex", "sections/intro.tex"]);
    fireEvent.change(search, { target: { value: "intro" } });
    const marks = screen.getByRole("option", { name: "sections/intro.tex" }).querySelectorAll("mark");
    expect([...marks].map((mark) => mark.textContent)).toEqual(["intro"]);
  });
});

describe("QuickOpenDialog scopes", () => {
  it("opens a file at the line a query ends with", () => {
    const { search, onOpen } = renderQuickOpen({ paths: ["main.tex", "sections/intro.tex"] });
    fireEvent.change(search, { target: { value: "intro:42" } });
    expect(screen.getByRole("option", { name: "sections/intro.tex" }).textContent).toContain(":42");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("sections/intro.tex", 42);
  });

  it("goes to a line of the file on screen", () => {
    const { search, onLine } = renderQuickOpen({ current: "main.tex" });
    fireEvent.change(search, { target: { value: ":17" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("Go to line 17");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onLine).toHaveBeenCalledWith(17);
  });

  it("lists sections and labels after @, reading them once", () => {
    const symbols = vi.fn(() => [
      { id: "section:1", label: "Introduction", detail: "main.tex:3", group: "Section" },
      { id: "label:main.tex:fig:arch", label: "fig:arch", detail: "main.tex:40", group: "Label" },
    ]);
    const { search, onSymbol } = renderQuickOpen({ symbols });
    fireEvent.change(search, { target: { value: "@" } });
    expect(optionNames()).toEqual(["Introduction", "fig:arch"]);
    fireEvent.change(search, { target: { value: "@arch" } });
    expect(optionNames()).toEqual(["fig:arch"]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSymbol).toHaveBeenCalledWith(expect.objectContaining({ id: "label:main.tex:fig:arch" }));
    expect(symbols).toHaveBeenCalledTimes(1);
  });
});
