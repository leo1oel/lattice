import { useCallback, useState } from "react";
import type { AssetPreview, PaperSummary } from "../app-types";
import { useRefState } from "./effect-helpers";

export type PaperView = "blog" | "fulltext";

/** The two cached reading files of an imported Paper. */
export function paperDocumentPath(arxivId: string, view: PaperView): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- project-relative file path
  return `.research/papers/${arxivId}/${view === "blog" ? "blog.md" : "paper.md"}`;
}

/**
 * The editable buffers behind the canvas: the primary file (or a Paper, which
 * owns the primary buffer even when drawn on the right), the secondary split
 * pane, and whichever asset either pane previews. Every buffer has a ref twin
 * for async work (saves, loads, sync); the helpers write both halves together.
 */
export function useDocumentBuffers() {
  const [activeFile, setActiveFile, activeFileRef, showActiveFile] = useRefState("");
  const [source, setSource, sourceRef, setPrimarySource] = useRefState("");
  const [savedSource, setSavedSource, savedSourceRef, setPrimarySaved] = useRefState("");
  const [secondaryFile, setSecondaryFile, secondaryFileRef, showSecondaryFile] = useRefState<string | null>(null);
  const [secondarySource, setSecondarySource, secondarySourceRef, setSecondarySourceLive] = useRefState("");
  const [secondarySavedSource, setSecondarySavedSource, secondarySavedRef, setSecondarySaved] = useRefState("");
  const [activeAsset, setActiveAsset, activeAssetRef, showActiveAsset] = useRefState<AssetPreview | null>(null);
  const [secondaryAsset, , secondaryAssetRef, showSecondaryAsset] = useRefState<AssetPreview | null>(null);
  const [activePaper, setActivePaper] = useState<PaperSummary | null>(null);
  const [paperMarkdown, setPaperMarkdown, paperMarkdownRef, setPaperMarkdownLive] = useRefState("");
  const [savedPaperMarkdown, , savedPaperMarkdownRef, setSavedPaperMarkdown] = useRefState("");
  // The alphaXiv overview ("blog") is the default reading view; null when the
  // paper has no report. `paperView` picks which of blog/full-text is shown.
  const [paperBlog, setPaperBlog, paperBlogRef, setPaperBlogLive] = useRefState<string | null>(null);
  const [savedPaperBlog, , savedPaperBlogRef, setSavedPaperBlog] = useRefState<string | null>(null);
  const [paperView, setPaperView] = useState<PaperView>("blog");
  // A Paper owns the primary document buffer even when it is drawn on the
  // right; the other visible document stays in the existing secondary buffer.
  const [paperSide, setPaperSide] = useState<"left" | "right">("left");

  /** Replace the primary buffer with durable content (live and saved agree). */
  const commitPrimaryText = useCallback((content: string) => {
    setPrimarySource(content);
    setPrimarySaved(content);
  }, [setPrimarySaved, setPrimarySource]);
  const commitSecondaryText = useCallback((content: string) => {
    setSecondarySourceLive(content);
    setSecondarySaved(content);
  }, [setSecondarySaved, setSecondarySourceLive]);
  /** Durable content for `path` reached disk: show it in whichever pane holds it. */
  const commitOpenText = useCallback((path: string, content: string) => {
    if (activeFileRef.current === path) commitPrimaryText(content);
    if (secondaryFileRef.current === path) commitSecondaryText(content);
  }, [activeFileRef, commitPrimaryText, commitSecondaryText, secondaryFileRef]);
  /** Like commitOpenText, but never replaces a pane holding unsaved edits. */
  const commitCleanOpenText = useCallback((path: string, content: string) => {
    if (activeFileRef.current === path && sourceRef.current === savedSourceRef.current) {
      commitPrimaryText(content);
    }
    if (secondaryFileRef.current === path && secondarySourceRef.current === secondarySavedRef.current) {
      commitSecondaryText(content);
    }
  }, [
    activeFileRef, commitPrimaryText, commitSecondaryText, savedSourceRef, secondaryFileRef, secondarySavedRef,
    secondarySourceRef, sourceRef,
  ]);
  const showPrimaryText = useCallback((path: string, content: string) => {
    showActiveFile(path);
    commitPrimaryText(content);
  }, [commitPrimaryText, showActiveFile]);
  const showSecondaryText = useCallback((path: string | null, content = "", saved = content) => {
    showSecondaryFile(path);
    setSecondarySourceLive(content);
    setSecondarySaved(saved);
  }, [setSecondarySaved, setSecondarySourceLive, showSecondaryFile]);
  const clearSecondaryPane = useCallback(() => {
    showSecondaryText(null);
    showSecondaryAsset(null);
  }, [showSecondaryAsset, showSecondaryText]);
  const setPaperBuffers = useCallback((
    markdown: string,
    blog: string | null,
    savedMarkdown = markdown,
    savedBlog = blog,
  ) => {
    setPaperMarkdownLive(markdown);
    setSavedPaperMarkdown(savedMarkdown);
    setPaperBlogLive(blog);
    setSavedPaperBlog(savedBlog);
  }, [setPaperBlogLive, setPaperMarkdownLive, setSavedPaperBlog, setSavedPaperMarkdown]);
  const markPaperSaved = useCallback((view: PaperView, content: string) => {
    if (view === "blog") setSavedPaperBlog(content);
    else setSavedPaperMarkdown(content);
  }, [setSavedPaperBlog, setSavedPaperMarkdown]);
  /** Leave Paper reading: the primary buffer belongs to a file again. */
  const closePaper = useCallback(() => {
    setActivePaper(null);
    setPaperBuffers("", null);
  }, [setPaperBuffers]);
  /** Follow a rename or move of the files the panes hold. */
  const remapOpenPaths = useCallback((remap: (path: string) => string) => {
    activeFileRef.current = remap(activeFileRef.current);
    secondaryFileRef.current = secondaryFileRef.current && remap(secondaryFileRef.current);
    setActiveFile((path) => remap(path));
    setSecondaryFile((path) => path && remap(path));
    setActiveAsset((asset) => asset && { ...asset, path: remap(asset.path) });
  }, [activeFileRef, secondaryFileRef, setActiveAsset, setActiveFile, setSecondaryFile]);
  const paperBuffersDirty = useCallback(() => (
    paperMarkdownRef.current !== savedPaperMarkdownRef.current || paperBlogRef.current !== savedPaperBlogRef.current
  ), [paperBlogRef, paperMarkdownRef, savedPaperBlogRef, savedPaperMarkdownRef]);

  const activePaperPath = activePaper ? paperDocumentPath(activePaper.arxivId, paperView) : null;
  const activePaperDirty = Boolean(activePaper) && (paperMarkdown !== savedPaperMarkdown || paperBlog !== savedPaperBlog);

  return {
    activeFile, setActiveFile, activeFileRef,
    source, setSource, sourceRef, setPrimarySource,
    savedSource, setSavedSource, savedSourceRef, setPrimarySaved,
    secondaryFile, secondaryFileRef,
    secondarySource, setSecondarySource, secondarySourceRef, setSecondarySourceLive,
    secondarySavedSource, setSecondarySavedSource, secondarySavedRef, setSecondarySaved,
    activeAsset, activeAssetRef, showActiveAsset,
    secondaryAsset, secondaryAssetRef, showSecondaryAsset,
    activePaper, setActivePaper, activePaperPath, activePaperDirty,
    paperMarkdown, setPaperMarkdown, paperMarkdownRef,
    savedPaperMarkdown, savedPaperMarkdownRef, paperBlog, setPaperBlog, paperBlogRef, savedPaperBlog, savedPaperBlogRef,
    paperView, setPaperView, paperSide, setPaperSide,
    commitPrimaryText, commitSecondaryText, commitOpenText, commitCleanOpenText,
    showPrimaryText, showSecondaryText, clearSecondaryPane,
    setPaperBuffers, markPaperSaved, closePaper, remapOpenPaths,
    paperBuffersDirty,
  };
}
