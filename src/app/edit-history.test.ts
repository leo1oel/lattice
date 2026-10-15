import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runEditHistory } from "./edit-history";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

// CodeMirror reads the platform once, at load, to bind Mod to ⌘ rather than
// Ctrl; the menu's press is ⌘Z, as on the Mac.
let codemirror: {
  view: typeof import("@codemirror/view");
  state: typeof import("@codemirror/state");
  commands: typeof import("@codemirror/commands");
};
beforeAll(async () => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  codemirror = {
    view: await import("@codemirror/view"),
    state: await import("@codemirror/state"),
    commands: await import("@codemirror/commands"),
  };
});

afterEach(() => {
  vi.mocked(invoke).mockClear();
  document.body.replaceChildren();
});

function sourceEditor() {
  const { EditorView, keymap } = codemirror.view;
  const { history, historyKeymap } = codemirror.commands;
  const view = new EditorView({
    doc: "\\section{Intro}",
    extensions: [history(), keymap.of(historyKeymap)],
    parent: document.body.appendChild(document.createElement("div")),
  });
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\nTyped." }, userEvent: "input.type" });
  view.contentDOM.focus();
  return view;
}

describe("Edit ▸ Undo and Redo", () => {
  it("step the focused source editor's own history, without WebKit's undo", () => {
    const view = sourceEditor();
    runEditHistory("undo");
    expect(view.state.doc.toString()).toBe("\\section{Intro}");
    runEditHistory("redo");
    expect(view.state.doc.toString()).toBe("\\section{Intro}\nTyped.");
    expect(invoke).not.toHaveBeenCalled();
    view.destroy();
  });

  it("reach an editor focused inside a shadow root", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const field = host.attachShadow({ mode: "open" }).appendChild(document.createElement("div"));
    field.tabIndex = 0;
    const presses: string[] = [];
    field.addEventListener("keydown", (event) => {
      presses.push(`${event.metaKey ? "⌘" : ""}${event.shiftKey ? "⇧" : ""}${event.key}`);
      event.preventDefault();
    });
    field.focus();
    runEditHistory("redo");
    expect(presses).toEqual(["⌘⇧Z"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leave a plain text field to WebKit's own undo", () => {
    const field = document.body.appendChild(document.createElement("input"));
    field.focus();
    runEditHistory("undo");
    expect(invoke).toHaveBeenCalledWith("native_edit_history", { redo: false });
    runEditHistory("redo");
    expect(invoke).toHaveBeenLastCalledWith("native_edit_history", { redo: true });
  });
});
