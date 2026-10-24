import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, SetStateAction } from "react";
import type { RenameSymbolResult, RenameTarget } from "../app-types";
import { toMessage } from "../app-utils";
import type { SymbolOccurrence } from "../project/references-panel";
import { loadBibliographyIndex } from "./use-project-library";
import type { UpdateCanvasRequest } from "./use-canvas-requests";

/** What the references panel lists: every occurrence of one label or citation key. */
export type ReferenceHits = {
  kind: "label" | "citation";
  symbol: string;
  occurrences: SymbolOccurrence[];
};

/**
 * Rename the symbol the rename dialog was opened on to `name`. A label or
 * citation is renamed across the project on disk, then everything that read
 * the old name is refreshed; an environment rename or wrap is handed to the
 * canvas, which edits the open buffer. A failure stays in the dialog as its
 * error. Outside useSourceNavigation because its try/catch makes the React
 * Compiler skip the hook that holds it.
 */
export async function submitSymbolRename(target: RenameTarget, name: string, {
  activeFile, loadFile, applyBibliographyIndex, refreshUnusedSymbols, refreshHistory, forgetIncludedSources,
  setReferenceHits, showSymbolReferences, updateCanvasRequest, setRenameError, setRenameTarget,
}: {
  activeFile: string;
  loadFile: (path: string) => Promise<unknown>;
  applyBibliographyIndex: (index: Awaited<ReturnType<typeof loadBibliographyIndex>>) => void;
  refreshUnusedSymbols: () => Promise<unknown>;
  refreshHistory: () => Promise<unknown>;
  forgetIncludedSources: () => void;
  setReferenceHits: Dispatch<SetStateAction<ReferenceHits | null>>;
  showSymbolReferences: (kind: "label" | "citation", symbol: string) => Promise<void>;
  updateCanvasRequest: UpdateCanvasRequest;
  setRenameError: (error: string | null) => void;
  setRenameTarget: (target: RenameTarget | null) => void;
}): Promise<void> {
  try {
    if (target.kind === "label" || target.kind === "citation") {
      const result = await invoke<RenameSymbolResult>("rename_symbol", {
        kind: target.kind,
        oldName: target.kind === "label" ? target.label : target.key,
        newName: name,
      });
      applyBibliographyIndex(await loadBibliographyIndex());
      await refreshUnusedSymbols();
      await refreshHistory();
      if (result.changedFiles.includes(activeFile)) await loadFile(activeFile);
      forgetIncludedSources();
      setReferenceHits((current) => current && { kind: target.kind, symbol: name, occurrences: [] });
      await showSymbolReferences(target.kind, name);
    } else if (target.kind === "environment") {
      updateCanvasRequest("rename", { newName: name, id: crypto.randomUUID() });
    } else if (target.kind === "wrap-environment") {
      updateCanvasRequest("wrap", { name, id: crypto.randomUUID() });
    }
    setRenameError(null);
    setRenameTarget(null);
  } catch (reason) {
    setRenameError(toMessage(reason));
  }
}
