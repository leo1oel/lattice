import { act, cleanup, render } from "@testing-library/react";
import { undo, undoDepth } from "@codemirror/commands";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "./codemirror-host";
import { REVEAL_FLASH_MS, revealExtension, revealInEditor } from "./editor-reveal";
import { latex } from "./latex/latex-language";
import { parkEditor, resumeParkedEditor, retainParkedEditors, takeResumed } from "./parked-editors";

const ROOT = "/projects/thesis";
// Long enough that a state built from text parses only its start (3000
// characters) and leaves the rest to the idle parse worker.
const CHAPTER = Array.from({ length: 400 }, (_, index) => `\\section{Part ${index}} Text with \\emph{words} and $x^${index}$.`).join("\n");
const OTHER = "\\chapter{Other}\nShort.";
/** The pretend line height of `tabs`' layout. */
const LINE_PX = 20;
const EXTENSIONS: Extension[] = [latex(), revealExtension()];

afterEach(() => {
  cleanup();
  retainParkedEditors(null, []);
  vi.restoreAllMocks();
});

/**
 * The canvas's use of the host: one editor, remounted by key for each
 * document, with a pretend layout so scrolling means something in jsdom (a
 * 400 px viewport; `hidden` is a tab behind another, which reads as
 * unscrolled and zero-height, as `display: none` does).
 *
 * Each mount gets the file as read from `disk`, as the app reads it on every
 * switch: with the line breaks it has there, and with whatever changed it
 * while its tab was in the background. Leaving a document saves what was
 * typed in it first, as switching tabs does.
 */
function tabs(initial: Record<string, string>) {
  const disk = { ...initial };
  const typed: Record<string, string> = {};
  let shown = Object.keys(initial)[0];
  const mounts: { path: string; view: EditorView; layout: { scrollTop: number; hidden: boolean } }[] = [];
  const element = (path: string) => (
    <CodeMirrorHost
      key={path}
      value={disk[path]}
      extensions={EXTENSIONS}
      park={{ root: ROOT, path }}
      onChange={(value) => { typed[path] = value; }}
      onUpdate={() => {}}
      onCreateEditor={(view) => {
        const layout = { scrollTop: 0, hidden: false };
        vi.spyOn(view.scrollDOM, "scrollTop", "get").mockImplementation(() => (layout.hidden ? 0 : layout.scrollTop));
        vi.spyOn(view.scrollDOM, "scrollTop", "set").mockImplementation((top: number) => { layout.scrollTop = top; });
        vi.spyOn(view.scrollDOM, "clientHeight", "get").mockImplementation(() => (layout.hidden ? 0 : 400));
        // jsdom draws nothing, so the place is pretend too: every line LINE_PX tall.
        vi.spyOn(view, "scrollSnapshot").mockImplementation(() => {
          const { scrollTop } = view.scrollDOM;
          const line = view.state.doc.line(Math.min(view.state.doc.lines, 1 + Math.floor(scrollTop / LINE_PX)));
          return EditorView.scrollIntoView(line.from, { y: "start", yMargin: -(scrollTop % LINE_PX) }) as ReturnType<EditorView["scrollSnapshot"]>;
        });
        mounts.push({ path, view, layout });
      }}
    />
  );
  const rendered = render(element(shown));
  return {
    disk,
    current: () => mounts.at(-1)!,
    show: (path: string) => {
      if (shown in typed) disk[shown] = typed[shown];
      delete typed[shown];
      shown = path;
      rendered.rerender(element(path));
    },
  };
}

/** Let the measure pass a scroll or a mount requested run (rAF is a 0 ms timer under test). */
const measured = () => act(async () => {
  await new Promise((resolve) => { setTimeout(resolve, 5); });
});

describe("parked editors", () => {
  it("switching back to a tab resumes it as it was left: scroll anchor, selection, undo history and parse", async () => {
    const editor = tabs({ "chapter.tex": CHAPTER, "other.tex": OTHER });
    const first = editor.current();
    const { view } = first;
    // jsdom draws nothing, so the top line is pretend too: position 4 × scrollTop, 12 px into it.
    vi.spyOn(view, "scrollSnapshot").mockImplementation(() => (
      EditorView.scrollIntoView(view.scrollDOM.scrollTop * 4, { y: "start", yMargin: -12 }) as ReturnType<EditorView["scrollSnapshot"]>
    ));
    act(() => view.dispatch({ selection: { anchor: 4000, head: 4100 } }));
    // The writer scrolls, then types above the place; the tab is then hidden
    // behind the next one (reading as unscrolled) before its view goes.
    first.layout.scrollTop = 1000;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    await measured();
    act(() => view.dispatch({ changes: { from: 0, insert: "% draft\n" }, userEvent: "input.type" }));
    // The idle parse worker's job, done while the writer was in the tab.
    forceParsing(view, view.state.doc.length, 10_000);
    const tree = syntaxTree(view.state);
    expect(tree.length).toBe(view.state.doc.length);
    first.layout.hidden = true;

    editor.show("other.tex");
    // What the next view of the chapter is built with: the place read after
    // the scroll, moved down by the line typed above it.
    const parked = resumeParkedEditor(ROOT, "chapter.tex", editor.disk["chapter.tex"], EXTENSIONS);
    expect((parked?.scrollTo?.value as { range: { head: number }; yMargin: number }) ?? null)
      .toMatchObject({ range: { head: 4008 }, yMargin: -12 });
    editor.show("chapter.tex");
    await measured();

    const back = editor.current();
    expect(takeResumed(back.view)).toBe(true);
    expect(back.view).not.toBe(view);
    expect(back.view.state.selection.main).toMatchObject({ anchor: 4008, head: 4108 });
    expect(undoDepth(back.view.state)).toBe(1);
    // The same tree, whole: no frame of the text uncoloured while it is parsed again.
    expect(syntaxTree(back.view.state)).toBe(tree);
  });

  // The writer's report: switch A → B → A, scroll A to its end, switch to B
  // and back, and A came back at its end for a moment, moved, then jumped up
  // to where it had been before. A file with CRLF line breaks never resumed,
  // so every return fell back to the saved pixel offset, and then the caret.
  it.each([
    ["LF", CHAPTER],
    ["CRLF", CHAPTER.replaceAll("\n", "\r\n")],
  ])("resumes every return where it was last left, its very end included (%s line breaks)", async (_breaks, chapter) => {
    const editor = tabs({ "chapter.tex": chapter, "other.tex": OTHER });
    act(() => editor.current().view.dispatch({ selection: { anchor: 120 } }));
    editor.show("other.tex");
    editor.show("chapter.tex");
    await measured();
    const { doc } = editor.current().view.state;
    const { lines } = doc;
    const parkedPlace = () => {
      const scrollTo = resumeParkedEditor(ROOT, "chapter.tex", editor.disk["chapter.tex"], EXTENSIONS)?.scrollTo;
      const { range, yMargin } = scrollTo?.value as { range: { head: number }; yMargin: number };
      return { line: doc.lineAt(range.head).number, into: -yMargin };
    };
    // To the end, back up, to the end again, then left alone for a cycle.
    const places = [{ line: lines, into: 7 }, { line: 120, into: 4 }, { line: lines, into: 7 }, null];
    for (const place of places) {
      const tab = editor.current();
      expect(takeResumed(tab.view)).toBe(true);
      if (place) {
        tab.layout.scrollTop = (place.line - 1) * LINE_PX + place.into;
        tab.view.scrollDOM.dispatchEvent(new Event("scroll"));
        await measured();
      }
      tab.layout.hidden = true;
      editor.show("other.tex");
      expect(parkedPlace()).toEqual(place ?? { line: lines, into: 7 });
      editor.show("chapter.tex");
      await measured();
      // The caret stays where it was put; only the view moved.
      expect(editor.current().view.state.selection.main.head).toBe(120);
    }
  });

  // The writer's third report, reproduced against the real backend: the file
  // read back on the way to its tab was not the text parked with it, and such
  // a tab started over. It showed its place (its snapshot, built from the
  // text it last showed), jumped to the top, then down to its saved pixel
  // offset, on other lines.
  it.each([
    ["a line added at its end", (text: string) => `${text}\nAdded at the end.`],
    ["a paragraph added above the place", (text: string) => `\\section{Added} Above the place.\n${text}`],
    ["a line below the place rewritten, saved with CRLF", (text: string) => (
      text.replace("\\section{Part 300}", "\\section{Part three hundred}").replaceAll("\n", "\r\n")
    )],
  ])("comes back to its place when its file changed while the tab was in the background (%s)", async (_change, edit) => {
    const editor = tabs({ "chapter.tex": CHAPTER, "other.tex": OTHER });
    const tab = editor.current();
    act(() => tab.view.dispatch({ changes: { from: 4000, insert: "typed " }, selection: { anchor: 4006 }, userEvent: "input.type" }));
    tab.layout.scrollTop = 199 * LINE_PX + 7;
    tab.view.scrollDOM.dispatchEvent(new Event("scroll"));
    await measured();
    const topLine = tab.view.state.doc.line(200).text;
    tab.layout.hidden = true;
    editor.show("other.tex");
    editor.disk["chapter.tex"] = edit(editor.disk["chapter.tex"]);
    editor.show("chapter.tex");
    await measured();

    const { view } = editor.current();
    const onDisk = editor.disk["chapter.tex"].replaceAll("\r\n", "\n");
    expect(takeResumed(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(onDisk);
    // The same line at the top, as far into it, and the caret after the typing.
    const scrollTo = resumeParkedEditor(ROOT, "chapter.tex", editor.disk["chapter.tex"], EXTENSIONS)?.scrollTo;
    const { range, yMargin } = scrollTo?.value as { range: { head: number }; yMargin: number };
    expect(view.state.doc.lineAt(range.head).text).toBe(topLine);
    expect(yMargin).toBe(-7);
    const { head } = view.state.selection.main;
    expect(view.state.sliceDoc(head - 6, head)).toBe("typed ");
    // Undo takes back the writer's typing, not the change made outside.
    expect(undoDepth(view.state)).toBe(1);
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe(onDisk.replace("typed ", ""));
  });

  it("does not bring back a jump's mark whose clearing timer died with its view", async () => {
    const editor = tabs({ "chapter.tex": CHAPTER, "other.tex": OTHER });
    act(() => revealInEditor(editor.current().view, { from: 4000 }));
    expect(editor.current().view.contentDOM.querySelector(".cm-reveal-flash")).not.toBeNull();
    editor.show("other.tex");
    const later = Date.now() + REVEAL_FLASH_MS + 1;
    vi.spyOn(Date, "now").mockReturnValue(later);
    editor.show("chapter.tex");
    await measured();

    expect(takeResumed(editor.current().view)).toBe(true);
    expect(editor.current().view.contentDOM.querySelector(".cm-reveal-flash")).toBeNull();
  });

  it("keeps a parked editor only for the open tabs of the open project", () => {
    const state = EditorState.create({ doc: CHAPTER, extensions: EXTENSIONS });
    parkEditor(ROOT, "a.tex", state, null);
    parkEditor(ROOT, "b.tex", state, null);
    parkEditor("/projects/other", "a.tex", state, null);

    retainParkedEditors(ROOT, ["a.tex"]);

    expect(resumeParkedEditor(ROOT, "a.tex", CHAPTER, EXTENSIONS)).not.toBeNull();
    expect(resumeParkedEditor(ROOT, "b.tex", CHAPTER, EXTENSIONS)).toBeNull();
    expect(resumeParkedEditor("/projects/other", "a.tex", CHAPTER, EXTENSIONS)).toBeNull();
  });
});
