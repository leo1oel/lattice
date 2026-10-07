import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  addCursorAbove, addCursorBelow, copyLineDown, cursorMatchingBracket, defaultKeymap, historyKeymap, indentLess, indentMore,
  indentWithTab, insertBlankLine, moveLineDown, moveLineUp, redo, selectLine, undo,
} from "@codemirror/commands";
import { foldAll, foldCode, foldKeymap, unfoldAll, unfoldCode } from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { findNext, findPrevious, searchKeymap, selectNextOccurrence } from "@codemirror/search";
import type { Command, KeyBinding } from "@codemirror/view";
import { withoutAppShortcuts } from "./editor-app-shortcuts";

/** The keys every source editor shares (codemirror-host's base setup), less those App owns. */
export const baseEditorKeymap: readonly KeyBinding[] = withoutAppShortcuts([
  ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap,
  indentWithTab,
]);

/**
 * The base keys the shortcut sheet lists, named by the command they run: the
 * sheet finds each one's key in `baseEditorKeymap` (as a Mac binds it), so it
 * shows what the editor binds, and drops a command App took the key of.
 * `shift` names a command reached as a binding's Shift variant.
 */
const EDITOR_SHORTCUTS: Array<{ label: MessageDescriptor; commands: Array<{ run: Command; shift?: true }> }> = [
  { label: msg`Undo`, commands: [{ run: undo }] },
  { label: msg`Redo`, commands: [{ run: redo }] },
  { label: msg`Select the next occurrence`, commands: [{ run: selectNextOccurrence }] },
  { label: msg`Select the line`, commands: [{ run: selectLine }] },
  { label: msg`Move the line up or down`, commands: [{ run: moveLineUp }, { run: moveLineDown }] },
  { label: msg`Duplicate the line`, commands: [{ run: copyLineDown }] },
  { label: msg`Add a cursor above or below`, commands: [{ run: addCursorAbove }, { run: addCursorBelow }] },
  { label: msg`Insert a line below`, commands: [{ run: insertBlankLine }] },
  { label: msg`Indent or outdent`, commands: [{ run: indentMore }, { run: indentLess, shift: true }] },
  { label: msg`Go to the matching bracket`, commands: [{ run: cursorMatchingBracket }] },
  { label: msg`Fold or unfold`, commands: [{ run: foldCode }, { run: unfoldCode }] },
  { label: msg`Fold or unfold everything`, commands: [{ run: foldAll }, { run: unfoldAll }] },
  { label: msg`Next or previous match`, commands: [{ run: findNext }, { run: findPrevious, shift: true }] },
];

/** A binding's key name on a Mac. */
const macKey = (binding: KeyBinding) => binding.mac ?? binding.key;

/**
 * EDITOR_SHORTCUTS with each command's key as `baseEditorKeymap` binds it.
 * A command reached as a Shift variant takes the Shift of the binding it is
 * the variant of; one the keymap no longer binds is left out.
 */
export function editorShortcuts(keymap: readonly KeyBinding[] = baseEditorKeymap): Array<{ label: MessageDescriptor; keys: string[] }> {
  return EDITOR_SHORTCUTS.flatMap(({ label, commands }) => {
    const keys = commands.flatMap(({ run, shift }) => {
      const binding = keymap.find((candidate) => (shift ? candidate.shift === run : candidate.run === run) && macKey(candidate));
      const key = binding && macKey(binding);
      // eslint-disable-next-line lingui/no-unlocalized-strings -- a CodeMirror key name
      return key ? [shift ? `Shift-${key}` : key] : [];
    });
    return keys.length === commands.length ? [{ label, keys }] : [];
  });
}
