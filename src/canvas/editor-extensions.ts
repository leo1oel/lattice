import { useEffect, useState } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  EMPTY_EXTENSIONS,
  immediateTextLanguageExtensions,
  loadTextLanguageExtensions,
} from "../editor/editor-languages";
import type { EditorKeymap } from "../app-types";

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
    let disposed = false;
    void loadTextLanguageExtensions(path).then((extensions) => {
      if (!disposed) setLoaded({ path, extensions });
    });
    return () => { disposed = true; };
  }, [path]);

  return loaded.path === path ? loaded.extensions : immediateTextLanguageExtensions(path);
}

type VimGetCM = typeof import("@replit/codemirror-vim").getCM;

function readVimMode(cm: ReturnType<VimGetCM>): string {
  const state = cm?.state.vim;
  if (state?.insertMode) return "insert";
  return state?.mode ?? "normal";
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
const loadVimKeymapExtensions = (onVimModeChange: (mode: string) => void) =>
  import("@replit/codemirror-vim").then((module) => [
    module.vim({ status: false }),
    vimModeExtension(module.getCM, onVimModeChange),
  ]);
const loadEmacsKeymapExtensions = () =>
  import("@replit/codemirror-emacs").then((module) => [module.emacs()]);

/**
 * Vim/Emacs keymaps, loaded on demand.
 *
 * `onVimModeChange` must be referentially stable — the callers pass
 * `reportPrimaryVimMode`/`reportSecondaryVimMode`, which are `useCallback`s for
 * this reason. The effect below lists it as a dependency and unconditionally
 * calls `setLoaded` with a freshly allocated object, so an inline lambda at the
 * call site turns this into an infinite render loop rather than one extra
 * render. This hook is compiled by the React Compiler (DocumentCanvas itself is
 * not), so nothing else absorbs the mistake.
 */
export function useOptionalKeymapExtensions(
  keymap: EditorKeymap,
  onVimModeChange: (mode: string) => void,
): Extension[] {
  const [loaded, setLoaded] = useState<{ keymap: EditorKeymap; extensions: Extension[] }>({
    keymap: "default",
    extensions: EMPTY_EXTENSIONS,
  });

  useEffect(() => {
    let disposed = false;
    if (keymap === "default") {
      setLoaded({ keymap, extensions: EMPTY_EXTENSIONS });
      return () => { disposed = true; };
    }

    const loading = keymap === "vim"
      ? loadVimKeymapExtensions(onVimModeChange)
      : loadEmacsKeymapExtensions();
    void loading.then((extensions) => {
      if (!disposed) setLoaded({ keymap, extensions });
    });
    return () => { disposed = true; };
  }, [keymap, onVimModeChange]);

  return loaded.keymap === keymap ? loaded.extensions : EMPTY_EXTENSIONS;
}
