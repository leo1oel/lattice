import type { MouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { followPaperSourceLink } from "./paper-source-link-click";

const paper: PaperSummary = { arxivId: "1706.03762", citationKey: "vaswani2017", title: "Attention Is All You Need", hasFullText: true, hasBlog: false };

/** A plain click on a source link to page 7 of `paper`, as React hands it to the handler. */
function clickSourceLink() {
  const link = document.createElement("a");
  link.href = "https://arxiv.org/pdf/1706.03762#page=7";
  link.title = "We propose … attention mechanisms";
  link.textContent = "p. 7";
  document.body.append(link);
  const event = {
    button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    target: link, preventDefault: vi.fn(), stopPropagation: vi.fn(),
  } as unknown as MouseEvent;
  return { link, event };
}

const pdf = { pdfSource: null, openPdf: vi.fn() };

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("following a source link in a note", () => {
  it("opens the cited library paper at the linked page and quote", () => {
    const onOpenPaperSource = vi.fn();
    const { event } = clickSourceLink();
    followPaperSourceLink(event, { activePaper: null, pdf, papers: [paper], onOpenPaperSource });
    expect(onOpenPaperSource).toHaveBeenCalledWith(paper, { page: 7, first: "We propose", last: "attention mechanisms" });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("leaves a click that ends a drag selecting the link's text to the editor", () => {
    const onOpenPaperSource = vi.fn();
    const { link, event } = clickSourceLink();
    const range = document.createRange();
    range.setStart(link.firstChild!, 0);
    range.setEnd(link.firstChild!, 2);
    window.getSelection()!.addRange(range);
    followPaperSourceLink(event, { activePaper: null, pdf, papers: [paper], onOpenPaperSource });
    expect(onOpenPaperSource).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
