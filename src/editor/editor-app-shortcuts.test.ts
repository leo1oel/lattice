import { defaultKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers, type KeyBinding } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { withoutAppShortcuts } from "./editor-app-shortcuts";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function editor(doc: string, cursor: number, filter: (bindings: readonly KeyBinding[]) => readonly KeyBinding[] = withoutAppShortcuts) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: keymap.of(filter([...defaultKeymap, ...searchKeymap])),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

/** Mod is Ctrl here: jsdom does not report a Mac platform. */
const press = (view: EditorView, key: string, modifiers: KeyboardEventInit = {}) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", { key, ctrlKey: true, ...modifiers }), "editor");

describe("withoutAppShortcuts", () => {
  it("leaves the app's shortcuts to the app instead of also editing the document", () => {
    const unfiltered = editor("one\ntwo\n", 5, (bindings) => bindings);
    expect(press(unfiltered, "k", { shiftKey: true })).toBe(true);
    expect(unfiltered.state.doc.toString()).toBe("one\n");
    expect(press(editor("x", 0, (bindings) => bindings), "[")).toBe(true);

    const view = editor("\\section{Intro}\n\\cite{a}\nLast line\n", 18);
    // ⌘⇧K is Insert citation; CodeMirror's default deleted the line as well.
    expect(press(view, "k", { shiftKey: true })).toBe(false);
    expect(press(view, "[")).toBe(false);
    expect(press(view, "]")).toBe(false);
    expect(press(view, "g")).toBe(false);
    expect(press(view, "l", { shiftKey: true })).toBe(false);
    expect(view.state.doc.toString()).toBe("\\section{Intro}\n\\cite{a}\nLast line\n");
  });

  it("keeps the editor's other bindings, including find previous on ⌘⇧G", () => {
    const bindings = withoutAppShortcuts([...defaultKeymap, ...searchKeymap]);
    const keys = bindings.map((binding) => binding.key);
    expect(keys).toContain("Shift-Mod-g");
    expect(keys).toContain("Mod-f");
    expect(keys).toContain("Mod-Alt-g");
    expect(keys).not.toContain("Shift-Mod-k");
    expect(keys).not.toContain("Mod-g");
    expect(bindings.length).toBe(defaultKeymap.length + searchKeymap.length - 4);
  });
});
