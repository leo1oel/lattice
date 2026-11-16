import { useEffect, useState } from "react";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  EMPTY_EXTENSIONS,
  immediateTextLanguageExtensions,
  loadTextLanguageExtensions,
} from "../editor/editor-languages";
import type { EditorKeymap } from "../app-types";
import { thenUnlessDisposed } from "../app/effect-helpers";
import { defineVimExCommands } from "./vim-ex-commands";

export function isLatexSourcePath(path: string): boolean {
  return /\.(?:tex|sty|cls)$/i.test(path);
}

export function useTextLanguageExtensions(path: string): Extension[] {
  const [loaded, setLoaded] = useState<{ path: string; extensions: Extension[] }>(() => ({
    path,
    extensions: immediateTextLanguageExtensions(path),
  }));

  useEffect(() => {
    // Only the asynchronous resolution needs to reach React. Re-seeding state
    // with the synchronous answer committed one extra render of the whole app
    // per file switch, and handed CodeMirror an equal-but-new extension array
    // that made it reconfigure the view it had just created.
    if (!path || immediateTextLanguageExtensions(path).length > 0) return;
    return thenUnlessDisposed(loadTextLanguageExtensions(path), (extensions) => setLoaded({ path, extensions }));
  }, [path]);

  return loaded.path === path ? loaded.extensions : immediateTextLanguageExtensions(path);
}

// eslint-disable-next-line lingui/no-unlocalized-strings -- module specifier
type VimGetCM = typeof import("@replit/codemirror-vim").getCM;

function readVimMode(cm: ReturnType<VimGetCM>): string {
  const state = cm?.state.vim;
  return state?.insertMode ? "insert" : state?.mode ?? "normal";
}

function vimModeExtension(getCM: VimGetCM, onModeChange: (mode: string) => void): Extension {
  return ViewPlugin.fromClass(class {
    private readonly cm: ReturnType<VimGetCM>;
    private readonly handleModeChange = () => onModeChange(readVimMode(this.cm));

    constructor(view: EditorView) {
      this.cm = getCM(view);
      this.cm?.on("vim-mode-change", this.handleModeChange);
      this.handleModeChange();
    }

    destroy() {
      this.cm?.off("vim-mode-change", this.handleModeChange);
    }
  });
}

// Hoisted loaders: inline `import()` expressions inside a hook make the React
// Compiler bail out of it (the same pattern App.tsx uses for lazy panels).
//
// Vim must see a key before any keymap does: CodeMirror runs every
// `keymap.of` binding, whatever its own precedence, from one keydown handler
// placed where the first keymap appears, and the host's base setup puts one
// ahead of these extensions. Without `Prec.highest`, LaTeX typing rules bound
// to printable keys (`$` pairing math) ran in normal and visual mode, so `$`
// inserted `$$` instead of moving to the end of the line (#1020). In insert
// mode Vim passes unmapped keys on, so those rules still apply there.
export const loadVimKeymapExtensions = (onVimModeChange: (mode: string) => void) => import("@replit/codemirror-vim")
  .then((module): Extension[] => {
    defineVimExCommands(module.Vim);
    return [Prec.highest(module.vim({ status: false })), vimModeExtension(module.getCM, onVimModeChange)];
  });
const loadEmacsKeymapExtensions = () => import("@replit/codemirror-emacs").then((module) => [module.emacs()]);

/** Vim/Emacs keymaps, loaded on demand, and the Vim mode the editor last reported. */
export function useOptionalKeymapExtensions(keymap: EditorKeymap): [extensions: Extension[], vimMode: string] {
  const [loaded, setLoaded] = useState<{ keymap: EditorKeymap; extensions: Extension[] }>({ keymap: "default", extensions: EMPTY_EXTENSIONS });
  const [vimMode, setVimMode] = useState("normal");

  useEffect(() => {
    if (keymap === "default") {
      setLoaded({ keymap, extensions: EMPTY_EXTENSIONS });
      return;
    }
    const loading = keymap === "vim" ? loadVimKeymapExtensions(setVimMode) : loadEmacsKeymapExtensions();
    return thenUnlessDisposed(loading, (extensions) => setLoaded({ keymap, extensions }));
  }, [keymap]);

  return [loaded.keymap === keymap ? loaded.extensions : EMPTY_EXTENSIONS, vimMode];
}
