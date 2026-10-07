import { describe, expect, it } from "vitest";
import { i18n } from "@lingui/core";
import { selectLine } from "@codemirror/commands";
import { baseEditorKeymap, editorShortcuts } from "./editor-keymap";

describe("the source editors' listed keys", () => {
  const listed = () => Object.fromEntries(editorShortcuts().map(({ label, keys }) => [i18n._(label), keys]));

  it("finds each command's key in the base keymap, as a Mac binds it", () => {
    expect(listed()).toMatchObject({
      Undo: ["Mod-z"],
      Redo: ["Mod-Shift-z"],
      "Select the line": ["Ctrl-l"],
      "Indent or outdent": ["Tab", "Shift-Tab"],
      "Fold or unfold": ["Cmd-Alt-[", "Cmd-Alt-]"],
      "Next or previous match": ["F3", "Shift-F3"],
    });
    expect(editorShortcuts()).toHaveLength(13);
  });

  it("leaves out a command whose key the keymap no longer binds", () => {
    const without = baseEditorKeymap.filter((binding) => binding.run !== selectLine);
    expect(editorShortcuts(without).map(({ label }) => i18n._(label))).not.toContain("Select the line");
  });
});
