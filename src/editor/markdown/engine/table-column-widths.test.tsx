/**
 * Tables' column widths kept by the host (table-column-widths.ts), driven
 * through the editor as a reader resizes a column.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";
import { MIN_COLUMN_WIDTH, type TableColumnWidths } from "./table-column-widths";

type Props = VisualMarkdownEditorProps;

const TABLES = ["| Model | Score |", "| --- | --- |", "| Base | 1 |", "", "Between.", "", "| A | B |", "| --- | --- |", "| x | y |"].join("\n");

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };
const tables = () => [...document.querySelectorAll<HTMLTableElement>(".lx-md-surface table")];
const colWidths = (table: HTMLTableElement) => [...table.querySelectorAll("col")].map((col) => col.style.width);

function renderEditor(given: Partial<Props>) {
  const onChangeMarkdown = vi.fn<Props["onChangeMarkdown"]>(() => true);
  let current: Props = { text: TABLES, activePath: "notes.md", onChangeMarkdown, onUndo: () => true, onRedo: () => true, ...given };
  const view = render(<LatticeVisualMarkdownEditor {...current} />);
  return {
    onChangeMarkdown,
    rerender: (next: Partial<Props>) => view.rerender(<LatticeVisualMarkdownEditor {...(current = { ...current, ...next })} />),
  };
}

/** A host keeping widths as the GPUI island does, handing each change back. */
function keeper(widths: TableColumnWidths["widths"] = {}) {
  const onChange = vi.fn<TableColumnWidths["onChange"]>();
  return { widths, onChange };
}

/**
 * jsdom lays nothing out: every cell is drawn 100px wide from x = 0, and a
 * table laid out as wide as its content (the fit's measure) 180px.
 */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.closest("table")?.style.width === "max-content" ? 180 : 100;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 100, 20));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const firstHeader = () => tables()[0]!.querySelector("th")!;

describe("table column widths", () => {
  it("leaves tables as they were drawn when the host keeps no widths", async () => {
    renderEditor({});
    await waitFor(() => expect(tables()).toHaveLength(2));
    expect(document.querySelector("[data-lx-table]")).toBeNull();
    expect(tables()[0]).not.toHaveAttribute("data-sized");
    fireEvent.mouseMove(firstHeader(), { clientX: 98 });
    expect(document.querySelector(".lx-md-editor")).not.toHaveAttribute("data-column-resize");
  });

  it("sizes the table its index names, and keeps the widths out of the Markdown", async () => {
    const host = keeper({ 1: [120, 200] });
    const { onChangeMarkdown } = renderEditor({ tableColumnWidths: host });
    await waitFor(() => expect(tables()[1]).toHaveAttribute("data-sized"));
    expect(tables()[0]).not.toHaveAttribute("data-sized");
    expect(colWidths(tables()[1]!)).toEqual(["120px", "200px"]);
    expect(tables()[1]!.style.width).toBe("320px");
    expect(tables()[1]!.style.tableLayout).toBe("fixed");

    const editor = surface().editor;
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === "x") at = pos + 1;
      return at < 0;
    });
    act(() => { editor.view.dispatch(editor.state.tr.insertText("z", at)); });
    await waitFor(() => expect(onChangeMarkdown).toHaveBeenCalled());
    expect(String(onChangeMarkdown.mock.lastCall?.[0])).toBe(TABLES.replace("| x | y |", "| xz | y |"));
    expect(host.onChange).not.toHaveBeenCalled();
  });

  it("shows the resize cursor on a column border, and not inside a cell", async () => {
    renderEditor({ tableColumnWidths: keeper() });
    await waitFor(() => expect(tables()).toHaveLength(2));
    const frame = document.querySelector(".lx-md-editor")!;
    fireEvent.mouseMove(firstHeader(), { clientX: 98 });
    expect(frame).toHaveAttribute("data-column-resize");
    fireEvent.mouseMove(firstHeader(), { clientX: 50 });
    expect(frame).not.toHaveAttribute("data-column-resize");
  });

  it("drags a column border to resize the column, never under the minimum, and hands the widths to the host", async () => {
    const host = keeper();
    const { rerender } = renderEditor({ tableColumnWidths: host });
    await waitFor(() => expect(tables()).toHaveLength(2));
    fireEvent.mouseDown(firstHeader(), { clientX: 98, button: 0, detail: 1 });
    fireEvent.mouseMove(window, { clientX: 148 });
    expect(colWidths(tables()[0]!)).toEqual(["150px", "100px"]);
    fireEvent.mouseMove(window, { clientX: -400 });
    expect(colWidths(tables()[0]!)).toEqual([`${MIN_COLUMN_WIDTH}px`, "100px"]);
    fireEvent.mouseMove(window, { clientX: 158 });
    fireEvent.mouseUp(window, { clientX: 158 });
    expect(host.onChange).toHaveBeenCalledTimes(1);
    expect(host.onChange).toHaveBeenLastCalledWith(0, [160, 100]);

    rerender({ tableColumnWidths: { ...host, widths: { 0: [160, 100] } } });
    await waitFor(() => expect(colWidths(tables()[0]!)).toEqual(["160px", "100px"]));
    expect(colWidths(tables()[1]!)).toEqual(["", ""]);
  });

  it("does nothing on a press that does not move", async () => {
    const host = keeper();
    renderEditor({ tableColumnWidths: host });
    await waitFor(() => expect(tables()).toHaveLength(2));
    fireEvent.mouseDown(firstHeader(), { clientX: 98, button: 0, detail: 1 });
    fireEvent.mouseUp(window, { clientX: 98 });
    expect(host.onChange).not.toHaveBeenCalled();
    expect(tables()[0]).not.toHaveAttribute("data-sized");
  });

  it("fits a column to its content on a double-click on its border", async () => {
    const host = keeper({ 0: [60, 90] });
    renderEditor({ tableColumnWidths: host });
    await waitFor(() => expect(tables()[0]).toHaveAttribute("data-sized"));
    fireEvent.mouseDown(firstHeader(), { clientX: 98, button: 0, detail: 2 });
    expect(host.onChange).toHaveBeenLastCalledWith(0, [180, 90]);
    expect(colWidths(tables()[0]!)).toEqual(["180px", "90px"]);
  });

  it("drops widths saved for another column count", async () => {
    const host = keeper({ 0: [100, 100, 100], 1: [80, 90] });
    renderEditor({ tableColumnWidths: host });
    await waitFor(() => expect(host.onChange).toHaveBeenCalledWith(0, null));
    expect(host.onChange.mock.calls.every(([table, widths]) => table === 0 && widths === null)).toBe(true);
    expect(tables()[0]).not.toHaveAttribute("data-sized");
    expect(colWidths(tables()[1]!)).toEqual(["80px", "90px"]);
  });
});
