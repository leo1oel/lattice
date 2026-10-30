import { describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { createOpenDocumentsStore } from "./open-documents-store";

const PAPER: PaperSummary = { arxivId: "1706.03762", title: "Attention", authors: "Vaswani", hasFullText: true, hasBlog: true };

describe("open documents store", () => {
  it("starts with nothing open, in split view, and keeps each window's store apart", () => {
    const store = createOpenDocumentsStore();
    expect(store.getState()).toMatchObject({
      file: "", text: "", savedText: "", asset: null, paper: null, paperView: "blog",
      tabs: [], revealRequest: 0, mode: "split", opening: null, navStack: [], navIndex: -1,
    });
    store.getState().showFileText("main.tex", "Main");
    expect(createOpenDocumentsStore().getState().file).toBe("");
  });

  it("lands every write at once, so async work reads the latest buffer without waiting for a render", () => {
    const store = createOpenDocumentsStore();
    const { showFileText, setText, commitFileText } = store.getState();
    showFileText("main.tex", "Main");
    setText("Main, edited");
    expect(store.getState()).toMatchObject({ file: "main.tex", text: "Main, edited", savedText: "Main" });
    commitFileText("From disk");
    expect(store.getState()).toMatchObject({ text: "From disk", savedText: "From disk" });
  });

  it("takes values or updaters in its field setters, like useState", () => {
    const store = createOpenDocumentsStore();
    const { setTabs, setMode } = store.getState();
    setTabs(["a.tex", "b.tex"]);
    setTabs((tabs) => tabs.map((tab) => `chapters/${tab}`));
    setMode((mode) => (mode === "split" ? "pdf" : mode));
    expect(store.getState()).toMatchObject({ tabs: ["chapters/a.tex", "chapters/b.tex"], mode: "pdf" });
  });

  it("closes a Paper together with both of its reading buffers", () => {
    const store = createOpenDocumentsStore();
    const { setPaper, setPaperBuffers, setPaperBlog, closePaper } = store.getState();
    setPaper(PAPER);
    setPaperBuffers("Full text", "Overview");
    setPaperBlog("Overview, annotated");
    expect(store.getState()).toMatchObject({
      paperMarkdown: "Full text", savedPaperMarkdown: "Full text",
      paperBlog: "Overview, annotated", savedPaperBlog: "Overview",
    });
    closePaper();
    expect(store.getState()).toMatchObject({
      paper: null, paperMarkdown: "", savedPaperMarkdown: "", paperBlog: null, savedPaperBlog: null,
    });
  });

  it("adds a tab once, and counts every explicit open even of a tab already in the strip", () => {
    const store = createOpenDocumentsStore();
    const listener = vi.fn();
    store.subscribe((state, previous) => { if (state.tabs !== previous.tabs) listener(); });
    const { addTab, showTab } = store.getState();
    addTab("main.tex");
    addTab("main.tex");
    expect(listener).toHaveBeenCalledTimes(1);
    showTab("main.tex");
    showTab("intro.tex");
    expect(store.getState()).toMatchObject({ tabs: ["main.tex", "intro.tex"], revealRequest: 2 });
  });

  it("records jumps, drops the forward history on a new one, and moves onto a repeat of the current entry", () => {
    const store = createOpenDocumentsStore();
    const { pushNavigation, setNavIndex } = store.getState();
    pushNavigation("main.tex", 1);
    pushNavigation("main.tex", 40);
    pushNavigation("intro.tex", 3);
    setNavIndex(0);
    pushNavigation("main.tex", 1);
    expect(store.getState()).toMatchObject({ navStack: [{ path: "main.tex", line: 1 }], navIndex: 0 });
    pushNavigation("main.tex", 12);
    expect(store.getState()).toMatchObject({
      navStack: [{ path: "main.tex", line: 1 }, { path: "main.tex", line: 12 }], navIndex: 1,
    });
  });

  it("keeps the last 80 jumps", () => {
    const store = createOpenDocumentsStore();
    for (let line = 1; line <= 100; line += 1) store.getState().pushNavigation("main.tex", line);
    const { navStack, navIndex } = store.getState();
    expect(navStack).toHaveLength(80);
    expect(navStack[0]).toEqual({ path: "main.tex", line: 21 });
    expect(navIndex).toBe(79);
  });
});
