import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableGeneratorDialog } from "./table-generator-dialog";
import { managedTableSource, newTableData, tableAtCursor } from "./table-data";

vi.mock("../../history/file-diff-view", () => ({ FileDiffView: () => <div /> }));
afterEach(cleanup);

describe("table data review", () => {
  it("requires review, restores a generated table and replaces its captured range", () => {
    const data = newTableData();
    data.caption = "中文 caption";
    data.label = "tab:one";
    const source = `before\n${managedTableSource(data)}after`;
    const cursor = source.indexOf("\\begin");
    const apply = vi.fn(() => true);
    const onClose = vi.fn();
    render(<TableGeneratorDialog target={() => ({ source, cursor, apply })} onClose={onClose} />);
    expect(screen.getByLabelText("Caption")).toHaveValue(data.caption);
    fireEvent.change(screen.getByLabelText("Row 2, column 1"), { target: { value: "updated" } });
    expect(screen.queryByRole("button", { name: "Update table" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review source changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Update table" }));
    const block = tableAtCursor(source, cursor)!;
    expect(apply).toHaveBeenCalledWith(block.from, block.to, expect.stringContaining("updated"));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("leaves the dialog open when the captured document changed", () => {
    const onClose = vi.fn();
    const apply = vi.fn(() => false);
    render(<TableGeneratorDialog target={() => ({ source: "", cursor: 0, apply })} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Review source changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The document changed");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("does not offer an overwrite when a generated table was hand-edited", () => {
    const source = managedTableSource(newTableData()).replace("Col 1", "manual");
    render(<TableGeneratorDialog target={() => ({ source, cursor: source.indexOf("\\begin"), apply: vi.fn() })} onClose={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("source edits");
    expect(screen.queryByRole("button", { name: "Review source changes" })).toBeNull();
  });
});
