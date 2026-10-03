import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppendixBoundary, EditorPosition, ProjectSnapshot } from "../app-types";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import { activeOutlineNode, includedPathsIn, parseProjectOutline } from "../editor/latex/latex-outline";
import {
  findAppendixMarker, katexMacrosFromSources, mergeReferences, parseGraphicsPaths, parseLocalLabels, parseLocalMacros,
  type ReferenceInfo,
} from "../editor/latex/latex-text";
import { mergeTodosWithBuffer, type TodoHit } from "../project/todo-scavenger";

/** How deep `\input`/`\include` chains are followed from the root document. */
const MAX_INCLUDE_DEPTH = 8;
const NO_APPENDIX: AppendixBoundary = { kind: "none" };
const UNRESOLVED_APPENDIX: AppendixBoundary = { kind: "unresolved" };

export type LatexStructureDeps = {
  project: ProjectSnapshot | null;
  /** The text file in the editor, and its text as of the last pause in typing. */
  activeFile: string;
  settledSource: string;
  /** Labels and citations the project's last scan found on disk. */
  references: ReferenceInfo[];
  /** TODO markers the project's last scan found on disk. */
  diskTodos: TodoHit[];
  editorPosition: EditorPosition | null;
  /** Something lists the outline (its panel, Go to symbol), so the included files are read for it. */
  outlineWanted: boolean;
  /**
   * The PDF the last successful build shows (its preview URL), or null: the
   * appendix's page there marks where the main body ends. A new URL is a new
   * PDF, whose pagination may differ though the appendix stayed on its line.
   */
  compiledPdf: string | null;
};

/**
 * What the project's LaTeX says about itself, kept live with the open
 * buffer: the section outline across `\input`/`\include` files, labels,
 * macros (for completion and KaTeX), `\graphicspath` roots, TODO markers, and
 * how many PDF pages the main body (before `\appendix`) takes.
 *
 * Only a `.tex` buffer joins the project-wide parses, through its settled
 * text: a Markdown buffer leaves every memo here inert while typing.
 */
export function useLatexStructure({
  project, activeFile, settledSource, references, diskTodos, editorPosition, outlineWanted, compiledPdf,
}: LatexStructureDeps) {
  // Included files the outline needed, as last read from disk.
  const [includedSources, setIncludedSources] = useState<Record<string, string>>({});
  const projectPaths = useMemo(
    () => (project ? flattenProjectPaths(project.files) : []),
    [project],
  );
  const rootDocumentPath = project?.manifest.rootDocuments.find((document) => document.isDefault)?.path
    ?? project?.manifest.rootDocuments[0]?.path
    ?? "";
  // Deriving this nullable scalar keeps every downstream memo inert while
  // typing Markdown — `null` is Object.is-stable across keystrokes, so the
  // source map and the parse chains behind it stop recomputing per character.
  const activeTexSource = activeFile.endsWith(".tex") ? settledSource : null;
  /** Every TeX source the parses read: the included files from disk, the open one from its buffer. */
  const liveSources = useMemo(() => ({
    ...includedSources,
    ...(activeTexSource != null ? { [activeFile]: activeTexSource } : {}),
  }), [activeFile, activeTexSource, includedSources]);

  // Go to symbol lists the same outline, so it reads the included files too:
  // with only the open buffer it found nothing in a project whose sections
  // live in \input/\include files, or whenever the root was not open.
  useEffect(() => {
    if (!project || !outlineWanted || !rootDocumentPath) return;
    let cancelled = false;
    const missing: string[] = [];
    const seen = new Set<string>();
    const visit = (path: string, depth: number) => {
      if (depth > MAX_INCLUDE_DEPTH || seen.has(path)) return;
      seen.add(path);
      const text = liveSources[path];
      if (text == null) {
        missing.push(path);
        return;
      }
      for (const included of includedPathsIn(text, projectPaths)) visit(included, depth + 1);
    };
    visit(rootDocumentPath, 0);
    if (!missing.length) return;
    void Promise.all(missing.map((path) => invoke<string>("read_project_file", { path }).then(
      (content) => [path, content] as const,
      () => [path, ""] as const,
    ))).then((entries) => {
      if (cancelled) return;
      setIncludedSources((current) => {
        const next = { ...current };
        let changed = false;
        for (const [path, content] of entries) {
          if (current[path] === content) continue;
          next[path] = content;
          changed = true;
        }
        return changed ? next : current;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [liveSources, outlineWanted, project, projectPaths, rootDocumentPath]);

  const outlineNodes = useMemo(() => {
    if (!rootDocumentPath) return [];
    return parseProjectOutline(rootDocumentPath, liveSources, projectPaths);
  }, [liveSources, projectPaths, rootDocumentPath]);
  const liveReferences = useMemo(() => (
    activeTexSource == null ? references : mergeReferences(references, activeFile, parseLocalLabels(activeFile, activeTexSource))
  ), [activeFile, activeTexSource, references]);
  const activeOutlineId = useMemo(() => {
    if (!activeFile.endsWith(".tex") || !editorPosition) return null;
    return activeOutlineNode(outlineNodes, activeFile, editorPosition.line)?.id ?? null;
  }, [activeFile, editorPosition, outlineNodes]);
  const macroSources = useMemo(() => Object.values(liveSources), [liveSources]);
  const macros = useMemo(() => parseLocalMacros(macroSources), [macroSources]);
  const graphicsRoots = useMemo(() => parseGraphicsPaths(macroSources), [macroSources]);
  const katexMacros = useMemo(() => katexMacrosFromSources(macroSources), [macroSources]);
  // TODOs come from .md buffers too (todo_source_path on the Rust side), so
  // this cannot ride the .tex-only scalar above. The rescan only visits
  // candidate lines, so it runs in the render that changes the settled text:
  // deferring it with useDeferredValue re-rendered all of App a second time
  // per keystroke.
  const todoHits = useMemo(
    () => mergeTodosWithBuffer(diskTodos, activeFile, settledSource),
    [activeFile, diskTodos, settledSource],
  );

  // Where \appendix sits, as two scalars rather than the marker object. The
  // source map behind it is rebuilt on every keystroke, so keying the SyncTeX
  // lookup on the map spent an IPC round trip per character typed while a
  // build was on screen. The appendix only moves when someone edits around it.
  const appendixMarker = useMemo(() => findAppendixMarker(liveSources), [liveSources]);
  const appendixMarkerPath = appendixMarker?.path ?? "";
  const appendixMarkerLine = appendixMarker?.line ?? 0;
  // SyncTeX's last answer: the main body's page count, or null when it could
  // not place the marker (no target, or the lookup failed). A rebuild keeps
  // the last answer until the next one arrives, so the count does not flicker;
  // the answer belongs to one project and marker, and is dropped once the PDF
  // goes away or either of them changes.
  const placementOwner = `${project?.root ?? ""}\n${appendixMarkerPath}\n${appendixMarkerLine}`;
  const [appendixPlacement, setAppendixPlacement] = useState<{ owner: string; mainPages: number | null } | null>(null);
  if (appendixPlacement && (!compiledPdf || appendixPlacement.owner !== placementOwner)) setAppendixPlacement(null);
  useEffect(() => {
    if (!compiledPdf || !appendixMarkerPath) return;
    let cancelled = false;
    void invoke<{ page: number } | null>("synctex_view", { path: appendixMarkerPath, line: appendixMarkerLine, column: 0 })
      .then((target) => (target ? Math.max(0, target.page - 1) : null), () => null)
      .then((mainPages) => {
        if (cancelled) return;
        setAppendixPlacement((current) => (
          current?.owner === placementOwner && current.mainPages === mainPages ? current : { owner: placementOwner, mainPages }
        ));
      });
    return () => {
      cancelled = true;
    };
  }, [appendixMarkerLine, appendixMarkerPath, compiledPdf, placementOwner]);
  const appendixBoundary = useMemo((): AppendixBoundary => {
    if (!appendixMarkerPath) return NO_APPENDIX;
    const mainPages = compiledPdf && appendixPlacement?.owner === placementOwner ? appendixPlacement.mainPages : null;
    return mainPages == null ? UNRESOLVED_APPENDIX : { kind: "resolved", mainPages };
  }, [appendixMarkerPath, appendixPlacement, compiledPdf, placementOwner]);

  /** Included files follow a rename or move. */
  const remapIncludedSources = useCallback((remap: (path: string) => string) => {
    setIncludedSources((current) => Object.fromEntries(
      Object.entries(current).map(([path, content]) => [remap(path), content]),
    ));
  }, []);
  /** Forget what the included files said (a rename rewrote them on disk); the outline reads them again. */
  const forgetIncludedSources = useCallback(() => setIncludedSources({}), []);

  return {
    projectPaths, rootDocumentPath, outlineNodes, activeOutlineId, liveReferences, macros, graphicsRoots, katexMacros,
    todoHits, appendixBoundary, remapIncludedSources, forgetIncludedSources,
  };
}
