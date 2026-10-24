import { useCallback, useEffect, useRef, useState } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import type { DocumentStore } from "./use-document-store";

/**
 * Save after a pause in typing, and when the writer leaves the editor; with
 * automatic builds on, a build follows each save. An open completion menu
 * holds both off, since it is still part of the edit.
 */
export function useDocumentAutosave(store: DocumentStore, save: () => Promise<boolean>) {
  const {
    depsRef, autoBuildEnabled, project, projectOperationGenerationRef, renderedRef, flushRef,
    file, asset, paper, text, savedText, textRef, savedRef,
    paperDirty, paperBlog, paperMarkdown, savedPaperBlog, savedPaperMarkdown,
  } = store;
  const [completionActive, setCompletionActive] = useState(false);
  const completionActiveRef = useRef(false);

  const automaticBuildPending = useRef(false);
  const automaticBuildQueued = useRef(false);
  const saveAndBuild = useCallback(async () => {
    automaticBuildQueued.current = true;
    if (automaticBuildPending.current) return;
    automaticBuildPending.current = true;
    const generation = projectOperationGenerationRef.current;
    const settle = () => { automaticBuildPending.current = false; };
    const step = async (): Promise<void> => {
      automaticBuildQueued.current = false;
      const saved = await save();
      if (generation !== projectOperationGenerationRef.current || !saved) return;
      // Only serialize the writes. The build pipeline owns build coalescing;
      // awaiting it here used to discard edits and attention changes during a build.
      depsRef.current.autoBuild.afterSave();
      if (automaticBuildQueued.current && textRef.current !== savedRef.current) return step();
    };
    await step().finally(settle);
  }, [depsRef, projectOperationGenerationRef, save, savedRef, textRef]);
  const saveRef = useLatestRef(save);
  const saveAndBuildRef = useLatestRef(saveAndBuild);
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    const documentDirty = Boolean(!paper && !asset && file && text !== savedText);
    if (!project || (!documentDirty && !paperDirty)) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const automatic = !paper && autoBuildEnabled;
    // A completion menu is still part of the current edit. Saving and building
    // while its keyboard or pointer selection is in progress compiles the
    // temporary `\cite{}` buffer and can replace the menu with an error panel.
    if (automatic && completionActive) return;
    const delay = automatic ? 1_200 : 900;
    // Call through refs so project entry and build state updates do not keep
    // resetting the idle timer (that starved autosave and left PDF stuck reloading).
    saveTimer.current = window.setTimeout(() => {
      if (automatic) void saveAndBuildRef.current();
      else void saveRef.current();
    }, delay);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [
    asset, autoBuildEnabled, completionActive, file, paper, paperBlog, paperDirty, paperMarkdown, project,
    saveAndBuildRef, saveRef, savedPaperBlog, savedPaperMarkdown, savedText, text,
  ]);

  /** The writer left the editor: save now (and build, with automatic builds). */
  const onEditorLeave = useCallback(() => {
    if (completionActiveRef.current) return;
    // A visual edit may still be debounced, and its publication updates refs
    // before React commits. Flush first and never inspect render-time source.
    if (flushRef.current?.() === false) return;
    if (!renderedRef.current.paper && depsRef.current.autoBuild.enabled && textRef.current !== savedRef.current) {
      void saveAndBuild();
    } else {
      // Saving on attention changes is independent of automatic compilation
      // and includes dirty paper buffers.
      void save();
    }
  }, [depsRef, flushRef, renderedRef, save, saveAndBuild, savedRef, textRef]);
  const closeCompletionRef = useRef<(() => void) | null>(null);
  /**
   * Leaving the editor for the PDF beside it. Scrolling or clicking the PDF
   * need not blur CodeMirror, so its completion ends here first, or the guard
   * above would hold off the save. A pointer merely leaving keeps the menu.
   */
  const onLeaveForPdf = useCallback(() => {
    closeCompletionRef.current?.();
    onEditorLeave();
  }, [onEditorLeave]);
  const onCompletionActiveChange = useCallback((active: boolean) => {
    completionActiveRef.current = active;
    setCompletionActive(active);
  }, []);
  const registerCompletionClose = useCallback((next: (() => void) | null) => { closeCompletionRef.current = next; }, []);

  return { onEditorLeave, onLeaveForPdf, onCompletionActiveChange, registerCompletionClose };
}
