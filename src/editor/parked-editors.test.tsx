import { act, cleanup, render } from "@testing-library/react";
import { undoDepth } from "@codemirror/commands";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "./codemirror-host";
import { REVEAL_FLASH_MS, revealExtension, revealInEditor } from "./editor-reveal";
import { latex } from "./latex/latex-language";
import { parkEditor, resumeParkedEditor, retainParkedEditors } from "./parked-editors";

const ROOT = "/projects/thesis";
// Long enough that a state built from text parses only its start (3000
// characters) and leaves the rest to the idle parse worker.
const CHAPTER = Array.from({ length: 400 }, (_, index) => `\\section{Part ${index}} Text with \\emph{words} and $x^${index}$.`).join("\n");
const OTHER = "\\chapter{Other}\nShort.";
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
 */
function tabs(initial: Record<string, string>) {
  const texts = { ...initial };
  const mounts: { path: string; view: EditorView; resumed: boolean; layout: { scrollTop: number; hidden: boolean } }[] = [];
  const element = (path: string) => (
    <CodeMirrorHost
      key={path}
      value={texts[path]}
      extensions={EXTENSIONS}
      park={{ root: ROOT, path }}
      onChange={(value) => { texts[path] = value; }}
      onUpdate={() => {}}
      onCreateEditor={(view, resumed) => {
        const layout = { scrollTop: 0, hidden: false };
        vi.spyOn(view.scrollDOM, "scrollTop", "get").mockImplementation(() => (layout.hidden ? 0 : layout.scrollTop));
        vi.spyOn(view.scrollDOM, "scrollTop", "set").mockImplementation((top: number) => { layout.scrollTop = top; });
        vi.spyOn(view.scrollDOM, "clientHeight", "get").mockImplementation(() => (layout.hidden ? 0 : 400));
        mounts.push({ path, view, resumed, layout });
      }}
    />
  );
  const rendered = render(element(Object.keys(initial)[0]));
  return {
    texts,
    current: () => mounts.at(-1)!,
    show: (path: string) => rendered.rerender(element(path)),
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
    const parked = resumeParkedEditor(ROOT, "chapter.tex", editor.texts["chapter.tex"], EXTENSIONS);
    expect((parked?.scrollTo?.value as { range: { head: number }; yMargin: number }) ?? null)
      .toMatchObject({ range: { head: 4008 }, yMargin: -12 });
    editor.show("chapter.tex");
    await measured();

    const back = editor.current();
    expect(back.resumed).toBe(true);
    expect(back.view).not.toBe(view);
    expect(back.view.state.selection.main).toMatchObject({ anchor: 4008, head: 4108 });
    expect(undoDepth(back.view.state)).toBe(1);
    // The same tree, whole: no frame of the text uncoloured while it is parsed again.
    expect(syntaxTree(back.view.state)).toBe(tree);
  });

  it("starts fresh when the text changed while the tab was in the background", async () => {
    const editor = tabs({ "chapter.tex": CHAPTER, "other.tex": OTHER });
    act(() => editor.current().view.dispatch({ selection: { anchor: 4000 } }));
    editor.show("other.tex");
    editor.texts["chapter.tex"] = `${CHAPTER}\nReloaded from disk.`;
    editor.show("chapter.tex");
    await measured();

    expect(editor.current().resumed).toBe(false);
    expect(editor.current().view.state.selection.main.head).toBe(0);
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

    expect(editor.current().resumed).toBe(true);
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
