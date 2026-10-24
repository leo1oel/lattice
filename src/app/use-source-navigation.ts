/**
 * Following what the source points at, and renaming what it names: a
 * definition (a label, an included file or figure, a bibliography entry), every
 * use of a label or citation key in the references panel, a link into the
 * project from a Markdown file or the agent, and the rename dialog for a
 * symbol or an environment.
 */
import { useCallback, useEffect, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { bibliographyEntryLine, type DefinitionTarget, type SymbolTarget } from "../editor/latex/latex-text";
import { parsePaperLinkPath } from "../papers/paper-link";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import type { SymbolOccurrence } from "../project/references-panel";
import type { PaperSummary, ProjectSnapshot, RenameTarget } from "../app-types";
import { isProjectAssetFilePath, resolveKnownWholeFileProjectPath } from "../app-utils";
import { showingErrors } from "./notify";
import { submitSymbolRename, type ReferenceHits } from "./symbol-rename-action";
import type { UpdateCanvasRequest } from "./use-canvas-requests";
import type { OpenDocuments } from "./use-open-documents";
import type { useProjectLibrary } from "./use-project-library";
import type { useProjectTree } from "./use-project-tree";

export function useSourceNavigation({
  project, projectRef, papers, documents, library, forgetIncludedSources, updateCanvasRequest, tree, openProjectPathRef,
}: {
  project: ProjectSnapshot | null;
  projectRef: RefObject<ProjectSnapshot | null>;
  papers: PaperSummary[];
  documents: OpenDocuments;
  library: Pick<ReturnType<typeof useProjectLibrary>, "applyBibliographyIndex" | "refreshUnusedSymbols" | "refreshHistory">;
  forgetIncludedSources: () => void;
  updateCanvasRequest: UpdateCanvasRequest;
  tree: Pick<ReturnType<typeof useProjectTree>, "openFileFromClick" | "openAssetFromClick">;
  /** Where the agent's links reach `openMarkdownProjectPath`: the Synara host is set up before it. */
  openProjectPathRef: RefObject<(path: string) => void>;
}) {
  const { t } = useLingui();
  const { file: activeFile, text: source, openFile, openAsset, openPaper, load: loadFile } = documents;
  const { applyBibliographyIndex, refreshUnusedSymbols, refreshHistory } = library;
  const { openFileFromClick: openProjectFileFromClick, openAssetFromClick: openProjectAssetFromClick } = tree;
  const [referenceHits, setReferenceHits] = useState<ReferenceHits | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const openMarkdownProjectPath = useCallback((path: string) => {
    const resolvedPath = resolveKnownWholeFileProjectPath(
      path,
      flattenProjectPaths(projectRef.current?.files ?? []),
    );
    // A link into a paper's cached markdown opens the Papers reading view,
    // not a plain editor tab: the plain tab loses the blog/full-text switch
    // and the paper selection context the agent reads. Falls through for a
    // paper that is no longer in the library.
    const paperLink = parsePaperLinkPath(resolvedPath);
    if (paperLink) {
      const paper = papers.find((item) => item.arxivId === paperLink.arxivId
        && (item.hasFullText || item.hasBlog));
      if (paper) {
        // The view the link named, when it is locally readable.
        void openPaper(paper, { view: paperLink.view });
        return;
      }
    }
    if (isProjectAssetFilePath(resolvedPath)) openProjectAssetFromClick(resolvedPath);
    else openProjectFileFromClick(resolvedPath);
  }, [openPaper, openProjectAssetFromClick, openProjectFileFromClick, papers, projectRef]);
  useEffect(() => {
    openProjectPathRef.current = openMarkdownProjectPath;
  }, [openMarkdownProjectPath, openProjectPathRef]);

  const gotoDefinition = useCallback(async (target: DefinitionTarget) => {
    if (!project) return;
    await showingErrors(async () => {
      if (target.kind === "reference") return openFile(target.path, { line: target.line });
      if (target.kind === "include" || target.kind === "asset") {
        // A relative \input or \includegraphics path may name a file below a
        // search directory rather than the project root.
        const paths = flattenProjectPaths(project.files);
        const resolved = paths.includes(target.path)
          ? target.path
          : paths.find((path) => path.endsWith(`/${target.path}`));
        if (!resolved) {
          const path = target.path;
          throw new Error(target.kind === "include"
            ? t`Could not find included file “${path}”.`
            : t`Could not find figure “${path}”.`);
        }
        return target.kind === "include" ? openFile(resolved, { line: 1 }) : openAsset(resolved);
      }
      const bibliography = project.manifest.primaryBibliography;
      if (!bibliography) throw new Error(t`This project has no primary bibliography.`);
      const content = bibliography === activeFile
        ? source
        : await invoke<string>("read_project_file", { path: bibliography });
      await openFile(bibliography, { line: bibliographyEntryLine(content, target.key) ?? 1 });
    });
  }, [activeFile, openAsset, openFile, project, source, t]);

  /** List every occurrence of a label or citation key in the references panel. */
  const showSymbolReferences = useCallback(async (kind: "label" | "citation", symbol: string) => {
    const occurrences = await invoke<SymbolOccurrence[]>("find_symbol_occurrences", { kind, name: symbol });
    setReferenceHits({ kind, symbol, occurrences });
  }, []);

  const submitRename = useCallback(async (name: string) => {
    if (!renameTarget) return;
    await submitSymbolRename(renameTarget, name, {
      activeFile, loadFile, applyBibliographyIndex, refreshUnusedSymbols, refreshHistory, forgetIncludedSources,
      setReferenceHits, showSymbolReferences, updateCanvasRequest, setRenameError, setRenameTarget,
    });
  }, [
    activeFile, forgetIncludedSources, loadFile, refreshHistory, refreshUnusedSymbols, renameTarget, showSymbolReferences,
    updateCanvasRequest, applyBibliographyIndex,
  ]);

  const findSymbolReferences = useCallback((target: SymbolTarget) => showingErrors(
    () => showSymbolReferences(target.kind, target.kind === "label" ? target.label : target.key),
  ), [showSymbolReferences]);

  const beginRename = useCallback((target: RenameTarget) => {
    setRenameError(null);
    setRenameTarget(target);
  }, []);
  const beginSymbolRename = useCallback((target: SymbolTarget) => beginRename(target.kind === "label"
    ? { kind: "label", label: target.label }
    : { kind: "citation", key: target.key }), [beginRename]);

  const openSymbolOccurrence = useCallback((occurrence: SymbolOccurrence) => showingErrors(
    () => openFile(occurrence.path, { line: occurrence.line }),
  ), [openFile]);

  return {
    openMarkdownProjectPath, gotoDefinition, findSymbolReferences, beginRename, beginSymbolRename, openSymbolOccurrence,
    referenceHits, dismissReferenceHits: () => setReferenceHits(null),
    /** The rename dialog's state and actions. */
    rename: {
      target: renameTarget,
      error: renameError,
      submit: submitRename,
      close: () => {
        setRenameError(null);
        setRenameTarget(null);
      },
    },
  };
}
