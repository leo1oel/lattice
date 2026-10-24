import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary } from "../app-types";
import { PaperLibrary } from "./paper-library";
import type { PaperTextMatch } from "./paper-library-search";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const attention: PaperSummary = { arxivId: "1706.03762", title: "Attention Is All You Need", hasFullText: true, hasBlog: true };
const lora: PaperSummary = { arxivId: "2106.09685", title: "LoRA: Low-Rank Adaptation", hasFullText: true, hasBlog: false };

/** LoRA ranks first; its lines carry the marks the index found. */
const MATCHES: PaperTextMatch[] = [
  {
    key: lora.arxivId, titleMatch: false, matches: 5,
    hits: [
      { path: ".research/papers/2106.09685/paper.md", line: 12, text: "We freeze the attention weights.", highlights: [[14, 23]] },
      ...[20, 31, 44, 58].map((line) => ({ path: ".research/papers/2106.09685/paper.md", line, text: `Attention at line ${line}.`, highlights: [[0, 9]] as [number, number][] })),
    ],
  },
  { key: attention.arxivId, hits: [{ path: ".research/papers/1706.03762/blog.md", line: 7, text: "An overview of attention.", highlights: [[15, 24]] }] },
];

function renderSearch(query: string) {
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementation(async (command) => (command === "search_paper_library" ? MATCHES : []));
  const props: ComponentProps<typeof PaperLibrary> = {
    projectKey: "/tmp/paper", papers: [attention, lora], activePaper: null, paperFetchStates: {}, importInput: query, importing: false,
    onReveal: vi.fn(), onPaper: vi.fn(), onFetchFullText: vi.fn(), onCancelFetch: vi.fn(), onDeletePaper: vi.fn(), onEditBibEntry: vi.fn(),
    setImportInput: vi.fn(), onImport: vi.fn(), onCancelImport: vi.fn(), onAddPapers: vi.fn(), onSearchLiterature: vi.fn(),
  };
  render(<PaperLibrary {...props} />);
  return props;
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
}

const searchbox = () => screen.getByRole("searchbox", { name: "Search or import papers" });
const hitButtons = () => Array.from(document.querySelectorAll<HTMLElement>(".paper-hit, .paper-hit-more"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Papers panel full-text hits", () => {
  it("ranks papers as the index did and lists their marked lines, a few at a time", async () => {
    renderSearch("weights");
    await settle();
    expect(Array.from(document.querySelectorAll(".paper-row .paper-title"), (title) => title.textContent)).toEqual([lora.title, attention.title]);
    const [first] = hitButtons();
    expect(first).toHaveTextContent("We freeze the attention weights.");
    expect(first!.querySelector("mark")).toHaveTextContent("attention");
    // Three lines show; the rest the index returned are one click away.
    const more = screen.getByRole("button", { name: "2 more" });
    expect(hitButtons().filter((button) => button.classList.contains("paper-hit"))).toHaveLength(4);
    more.focus();
    fireEvent.click(more);
    expect(screen.queryByRole("button", { name: "2 more" })).toBeNull();
    expect(screen.getByRole("button", { name: "Attention at line 44." })).toHaveFocus();
  });

  it("opens the paper at a hit's line, in the reading file it was found in", async () => {
    const props = renderSearch("attention");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "We freeze the attention weights." }));
    expect(props.onPaper).toHaveBeenLastCalledWith(lora, { view: "fulltext", line: 12 });
    fireEvent.click(screen.getByRole("button", { name: "An overview of attention." }));
    expect(props.onPaper).toHaveBeenLastCalledWith(attention, { view: "blog", line: 7 });
  });

  it("walks from the box through each paper and its lines with the arrows, and Escape ends the search", async () => {
    const props = renderSearch("weights");
    await settle();
    const [loraRow, attentionRow] = Array.from(document.querySelectorAll<HTMLElement>(".paper-open"));
    const input = searchbox();
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(loraRow).toHaveFocus();
    fireEvent.keyDown(loraRow!, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "We freeze the attention weights." })).toHaveFocus();
    // Past LoRA's last stop ("2 more") to the next paper, and back up onto that stop.
    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(attentionRow).toHaveFocus();
    fireEvent.keyDown(attentionRow!, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "2 more" })).toHaveFocus();
    // The first paper's row hands the keyboard back to the box.
    loraRow!.focus();
    fireEvent.keyDown(loraRow!, { key: "ArrowUp" });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.setImportInput).toHaveBeenLastCalledWith("");
    vi.mocked(props.setImportInput).mockClear();
    loraRow!.focus();
    fireEvent.keyDown(loraRow!, { key: "Escape" });
    expect(props.setImportInput).toHaveBeenLastCalledWith("");
    expect(input).toHaveFocus();
  });
});
