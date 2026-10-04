import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppendixBoundary, EditorPosition, ProjectSnapshot } from "../app-types";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import { activeOutlineNode, includedPathsIn, parseProjectOutline } from "../editor/latex/latex-outline";
import {
  findAppendixMarker, katexMacrosFromSources, mergeReferences, parseGraphicsPaths, parseLocalLabels, parseLocalMacros,
  type ReferenceInfo,
} from "../editor/latex/latex-text";
import { changesReach, onProjectFilesChanged } from "../project/project-files-changed";
import { mergeTodosWithBuffer, type TodoHit } from "../project/todo-scavenger";

/** How deep `\input`/`\include` chains are followed from the root document. */
const MAX_INCLUDE_DEPTH = 8;
const NO_APPENDIX: AppendixBoundary = { kind: "none" };
const UNRESOLVED_APPENDIX: AppendixBoundary = { kind: "unresolved" };
const UNREAD_APPENDIX: AppendixBoundary = { kind: "unread" };
const NO_SOURCES: Record<string, string> = {};
const NO_PATHS: string[] = [];

/** Files the manuscript reaches, as last read from disk or left in the editor. */
type RetainedSources = {
  /** The project they were read from. */
  owner: string;
  sources: Record<string, string>;
  /** Files whose read failed: listed empty, but not known to be. */
  unreadable: string[];
};

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
  /**
   * Something lists the outline (its panel, Go to symbol), so the included
   * files are read for it. A built PDF reads them regardless.
   */
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
  const projectRoot = project?.root ?? "";
  const [retained, setRetained] = useState<RetainedSources>({ owner: projectRoot, sources: NO_SOURCES, unreadable: NO_PATHS });
  // What another project's files said never answers for this one.
  const ownRetained = retained.owner === projectRoot ? retained : null;
  const includedSources = ownRetained?.sources ?? NO_SOURCES;
  const unreadable = ownRetained?.unreadable ?? NO_PATHS;
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

  // The manuscript: the root document and every file it reaches through
  // \input/\include, in reading order, as far as their text is known. Only a
  // complete walk — nothing missing, no read that failed — can say what the
  // manuscript lacks; a file not yet read may hold anything.
  const manuscript = useMemo(() => {
    const sources: Record<string, string> = {};
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
      sources[path] = text;
      for (const included of includedPathsIn(text, projectPaths)) visit(included, depth + 1);
    };
    if (rootDocumentPath) visit(rootDocumentPath, 0);
    const complete = !missing.length && !unreadable.some((path) => (
      Object.hasOwn(sources, path) && !(path === activeFile && activeTexSource != null)
    ));
    return { sources, missing, complete };
  }, [activeFile, activeTexSource, liveSources, projectPaths, rootDocumentPath, unreadable]);

  // Read the files the manuscript reaches that no buffer holds. The outline
  // lists them (its panel, Go to symbol): with only the open buffer it found
  // nothing in a project whose sections live in \input/\include files, or
  // whenever the root was not open. A built PDF needs them too, whatever is
  // on screen: an \appendix in an unread file would read as no appendix, and
  // the whole PDF would be held to the main body's page budget.
  const scanWanted = outlineWanted || compiledPdf != null;
  useEffect(() => {
    if (!scanWanted || !manuscript.missing.length) return;
    let cancelled = false;
    const owner = projectRoot;
    void Promise.all(manuscript.missing.map((path) => invoke<string>("read_project_file", { path }).then(
      (content) => ({ path, content, read: true }),
      () => ({ path, content: "", read: false }),
    ))).then((entries) => {
      if (cancelled) return;
      setRetained((current) => {
        const base = current.owner === owner ? current : { owner, sources: NO_SOURCES, unreadable: NO_PATHS };
        let { sources, unreadable: failed } = base;
        for (const { path, content, read } of entries) {
          // A failed read lists as empty in the outline, but is remembered as
          // unread: it proves nothing about what the file holds.
          if (sources[path] !== content) sources = { ...sources, [path]: content };
          if (failed.includes(path) === read) failed = read ? failed.filter((other) => other !== path) : [...failed, path];
        }
        return base === current && sources === base.sources && failed === base.unreadable
          ? current
          : { owner, sources, unreadable: failed };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [manuscript, projectRoot, scanWanted]);

  // A file changed on disk (the agent, an Overleaf pull, a checkout) is read
  // again: its retained copy may lack an \appendix it now has, or keep one it
  // lost. The open buffer still shadows whatever is read for it.
  useEffect(() => {
    if (!projectRoot) return;
    return onProjectFilesChanged(projectRoot, (paths) => setRetained((current) => {
      if (current.owner !== projectRoot) return current;
      const stale = (path: string) => changesReach(paths, path);
      if (!Object.keys(current.sources).some(stale) && !current.unreadable.some(stale)) return current;
      return {
        owner: current.owner,
        sources: Object.fromEntries(Object.entries(current.sources).filter(([path]) => !stale(path))),
        unreadable: current.unreadable.filter((path) => !stale(path)),
      };
    }));
  }, [projectRoot]);

  // The open buffer shadows its retained copy, which may predate edits made
  // in it. Leaving a file the manuscript reaches keeps what the buffer last
  // said, so opening an unrelated file neither drops the root's \appendix
  // nor brings back a stale line for it. (Declared before the effect that
  // records the open buffer, so it still sees the one being left.)
  const openBufferRef = useRef<{ owner: string; path: string; text: string } | null>(null);
  useEffect(() => {
    const left = openBufferRef.current;
    if (!left || left.path === activeFile || left.owner !== projectRoot) return;
    setRetained((current) => {
      const base = current.owner === left.owner ? current : { owner: left.owner, sources: NO_SOURCES, unreadable: NO_PATHS };
      if (base === current && base.sources[left.path] === left.text && !base.unreadable.includes(left.path)) return current;
      return {
        owner: left.owner,
        sources: { ...base.sources, [left.path]: left.text },
        unreadable: base.unreadable.filter((path) => path !== left.path),
      };
    });
  }, [activeFile, projectRoot]);
  useEffect(() => {
    openBufferRef.current = activeTexSource != null && Object.hasOwn(manuscript.sources, activeFile)
      ? { owner: projectRoot, path: activeFile, text: activeTexSource }
      : null;
  }, [activeFile, activeTexSource, manuscript, projectRoot]);

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
  // Only the manuscript's own files: an unrelated .tex open in the editor has
  // no say in where this PDF's main body ends.
  const appendixMarker = useMemo(() => findAppendixMarker(manuscript.sources), [manuscript]);
  const appendixMarkerPath = appendixMarker?.path ?? "";
  const appendixMarkerLine = appendixMarker?.line ?? 0;
  // SyncTeX's last answer: the main body's page count, or null when it could
  // not place the marker (no target, or the lookup failed). A rebuild keeps
  // the last answer until the next one arrives, so the count does not flicker.
  // The answer belongs to one project and marker, and only shows while they
  // are current; it is dropped once the PDF goes away. Leaving a file of the
  // manuscript hides its marker for a render, until the effect below keeps
  // its text: the answer outlasts that, and is not asked again for the same PDF.
  const placementOwner = `${project?.root ?? ""}\n${appendixMarkerPath}\n${appendixMarkerLine}`;
  const [appendixPlacement, setAppendixPlacement] = useState<{
    owner: string;
    pdf: string;
    mainPages: number | null;
  } | null>(null);
  if (appendixPlacement && !compiledPdf) setAppendixPlacement(null);
  const placementCurrent = appendixPlacement?.owner === placementOwner;
  const placedInPdf = placementCurrent && appendixPlacement?.pdf === compiledPdf;
  useEffect(() => {
    if (!compiledPdf || !appendixMarkerPath || placedInPdf) return;
    let cancelled = false;
    void invoke<{ page: number } | null>("synctex_view", { path: appendixMarkerPath, line: appendixMarkerLine, column: 0 })
      .then((target) => (target ? Math.max(0, target.page - 1) : null), () => null)
      .then((mainPages) => {
        if (cancelled) return;
        setAppendixPlacement({ owner: placementOwner, pdf: compiledPdf, mainPages });
      });
    return () => {
      cancelled = true;
    };
  }, [appendixMarkerLine, appendixMarkerPath, compiledPdf, placedInPdf, placementOwner]);
  const appendixBoundary = useMemo((): AppendixBoundary => {
    if (!appendixMarkerPath) return manuscript.complete ? NO_APPENDIX : UNREAD_APPENDIX;
    const mainPages = compiledPdf && placementCurrent ? appendixPlacement?.mainPages : null;
    return mainPages == null ? UNRESOLVED_APPENDIX : { kind: "resolved", mainPages };
  }, [appendixMarkerPath, appendixPlacement, compiledPdf, manuscript.complete, placementCurrent]);

  /** Included files follow a rename or move. */
  const remapIncludedSources = useCallback((remap: (path: string) => string) => {
    setRetained((current) => ({
      owner: current.owner,
      sources: Object.fromEntries(Object.entries(current.sources).map(([path, content]) => [remap(path), content])),
      unreadable: current.unreadable.map(remap),
    }));
  }, []);
  /** Forget what the included files said (a rename rewrote them on disk); the outline reads them again. */
  const forgetIncludedSources = useCallback(
    () => setRetained((current) => ({ owner: current.owner, sources: NO_SOURCES, unreadable: NO_PATHS })),
    [],
  );

  return {
    projectPaths, rootDocumentPath, outlineNodes, activeOutlineId, liveReferences, macros, graphicsRoots, katexMacros,
    todoHits, appendixBoundary, remapIncludedSources, forgetIncludedSources,
  };
}
