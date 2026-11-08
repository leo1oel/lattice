import { describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { createOpenDocumentsStore } from "./open-documents-store";

const PAPER: PaperSummary = { arxivId: "1706.03762", title: "Attention", authors: "Vaswani", hasFullText: true, hasBlog: true };

describe("open documents store", () => {
  it("starts with nothing open, in split view, and keeps each window's store apart", () => {
    const store = createOpenDocumentsStore();
    expect(store.getState()).toMatchObject({
      file: "", text: "", savedText: "", asset: null, paper: null, paperView: "fulltext",
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

  it("carries a keystroke onto a co-author's text that landed before the editor took it in", () => {
    const store = createOpenDocumentsStore();
    const { showFileText, takeOutsideText, typeFileText } = store.getState();
    showFileText("main.tex", "We study attention.\n");
    // The co-author's words reach the buffer; the editor still shows the old text.
    takeOutsideText("We study attention closely.\n");
    typeFileText("Here we study attention.\n", "We study attention.\n");
    expect(store.getState().text).toBe("Here we study attention closely.\n");
    // Nothing moved behind the editor: the edit is the buffer.
    typeFileText("Here we study attention closely!\n", "Here we study attention closely.\n");
    expect(store.getState().text).toBe("Here we study attention closely!\n");
  });

  // Placed as ShareJS's text type places them: an insert inside text the
  // other side deleted lands where that text was, our own first at a tie.
  it("keeps a keystroke typed inside the word a co-author replaced, and their replacement too", () => {
    const store = createOpenDocumentsStore();
    const { showFileText, takeOutsideText, typeFileText } = store.getState();
    showFileText("main.tex", "one two three\n");
    takeOutsideText("one 2 three\n");
    typeFileText("one twLo three\n", "one two three\n", [{ p: 6, i: "L" }]);
    expect(store.getState()).toMatchObject({ text: "one L2 three\n", outsideText: "one L2 three\n" });
  });

  it("keeps edits at both ends of a line the co-author changed in the middle", () => {
    const store = createOpenDocumentsStore();
    const { showFileText, takeOutsideText, typeFileText } = store.getState();
    showFileText("main.tex", "one two three\n");
    takeOutsideText("one 2 three\n");
    // Carrying the edit as one span from "one" to "three" used to bring "two" back.
    typeFileText("ONE two THREE\n", "one two three\n");
    expect(store.getState().text).toBe("ONE 2 THREE\n");
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
