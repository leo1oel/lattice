import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BibVisualEditor } from "./bib-visual-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

// jsdom lays nothing out: the list is a 600 px view, which at 60 px a row
// shows 10 rows and draws 8 more either side.
const VIEW_HEIGHT = 600;
const ROW = 60;
const ENTRIES = 60;

const source = Array.from({ length: ENTRIES }, (_, index) => (
  `@article{key${index},\n  title = {Entry ${index}},\n  author = {Author ${index}},\n  year = {2020}\n}\n`
)).join("\n");

function renderList() {
  render(
    <BibVisualEditor
      path="references.bib"
      source={source}
      projectRoot="/project"
      editable
      papers={[]}
      usageRevision={0}
      onChange={() => true}
      onUndo={() => false}
      onRedo={() => false}
      onOpenLine={vi.fn()}
      onOpenPaper={vi.fn()}
      onOpenUrl={vi.fn()}
      onResolveCitation={vi.fn()}
    />,
  );
  return screen.getByRole("listbox", { name: "References" });
}

function scrollTo(list: HTMLElement, top: number) {
  list.scrollTop = top;
  fireEvent.scroll(list);
}

const drawn = () => screen.getAllByRole("option").map((row) => row.id);

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "listbox" ? VIEW_HEIGHT : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BibVisualEditor / drawn rows", () => {
  it("draws the first rows again when the view comes back to the top", () => {
    const list = renderList();
    expect(drawn()[0]).toBe("bib-row-0");
    // Far enough down that the rows are drawn again from row 6.
    scrollTo(list, 14 * ROW);
    expect(drawn()[0]).toBe("bib-row-6");
    // Back at the top, within OVERSCAN rows of the start: rows 0-5 are in view.
    scrollTo(list, 0);
    expect(drawn()[0]).toBe("bib-row-0");
  });

  it("draws the last rows when the view reaches the end", () => {
    const list = renderList();
    scrollTo(list, 36 * ROW);
    expect(drawn().at(-1)).toBe("bib-row-53");
    scrollTo(list, ENTRIES * ROW - VIEW_HEIGHT);
    expect(drawn().at(-1)).toBe(`bib-row-${ENTRIES - 1}`);
  });
});
