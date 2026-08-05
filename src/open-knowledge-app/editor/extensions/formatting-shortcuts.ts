import { Extension } from '@tiptap/core';

export const FormattingShortcuts = Extension.create({
  name: 'formattingShortcuts',

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
    };
  },
});
