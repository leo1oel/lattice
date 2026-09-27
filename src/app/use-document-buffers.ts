import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AssetPreview, PaperSummary } from "../app-types";

export type PaperView = "blog" | "fulltext";

/** The two cached reading files of an imported Paper. */
export function paperDocumentPath(arxivId: string, view: PaperView): string {
  return `.research/papers/${arxivId}/${view === "blog" ? "blog.md" : "paper.md"}`;
}

/**
 * The editable buffers behind the canvas: the primary file (or a Paper, which
 * owns the primary buffer even when drawn on the right), the secondary split
 * pane, and whichever asset either pane previews.
 *
 * Every buffer has a ref twin. Async work (saves, loads, sync) reads the refs,
 * because the state captured when it started is stale by the time it resumes;
 * the helpers below write both halves together so the two never disagree.
 */
export function useDocumentBuffers() {
  const [activeFile, setActiveFile] = useState("");
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [secondaryFile, setSecondaryFile] = useState<string | null>(null);
  const [secondarySource, setSecondarySource] = useState("");
  const [secondarySavedSource, setSecondarySavedSource] = useState("");
  const [activeAsset, setActiveAsset] = useState<AssetPreview | null>(null);
  const [secondaryAsset, setSecondaryAsset] = useState<AssetPreview | null>(null);
  const [activePaper, setActivePaper] = useState<PaperSummary | null>(null);
  const [paperMarkdown, setPaperMarkdown] = useState("");
  const [savedPaperMarkdown, setSavedPaperMarkdown] = useState("");
  // The alphaXiv overview ("blog") is the default reading view; null when the
  // paper has no report. `paperView` picks which of blog/full-text is shown.
  const [paperBlog, setPaperBlog] = useState<string | null>(null);
  const [savedPaperBlog, setSavedPaperBlog] = useState<string | null>(null);
  const [paperView, setPaperView] = useState<PaperView>("blog");
  // A Paper owns the primary document buffer even when it is drawn on the
  // right; the other visible document stays in the existing secondary buffer.
  const [paperSide, setPaperSide] = useState<"left" | "right">("left");

  const activeFileRef = useRef(activeFile);
  const sourceRef = useRef(source);
  const savedSourceRef = useRef(savedSource);
  const secondaryFileRef = useRef(secondaryFile);
  const secondarySourceRef = useRef(secondarySource);
  const secondarySavedRef = useRef(secondarySavedSource);
  const activeAssetRef = useRef(activeAsset);
  const secondaryAssetRef = useRef(secondaryAsset);
  activeFileRef.current = activeFile;
  sourceRef.current = source;
  savedSourceRef.current = savedSource;
  secondaryFileRef.current = secondaryFile;
  secondarySourceRef.current = secondarySource;
  secondarySavedRef.current = secondarySavedSource;
  activeAssetRef.current = activeAsset;
  secondaryAssetRef.current = secondaryAsset;
  const paperMarkdownRef = useRef(paperMarkdown);
  const savedPaperMarkdownRef = useRef(savedPaperMarkdown);
  const paperBlogRef = useRef(paperBlog);
  const savedPaperBlogRef = useRef(savedPaperBlog);
  useLayoutEffect(() => {
    paperMarkdownRef.current = paperMarkdown;
    savedPaperMarkdownRef.current = savedPaperMarkdown;
    paperBlogRef.current = paperBlog;
    savedPaperBlogRef.current = savedPaperBlog;
  }, [paperBlog, paperMarkdown, savedPaperBlog, savedPaperMarkdown]);

  /** Live primary edits: the ref leads so a save in the same turn sees them. */
  const setPrimarySource = useCallback((value: string) => {
    sourceRef.current = value;
    setSource(value);
  }, []);
  const setSecondarySourceLive = useCallback((value: string) => {
    secondarySourceRef.current = value;
    setSecondarySource(value);
  }, []);
  const setPrimarySaved = useCallback((value: string) => {
    savedSourceRef.current = value;
    setSavedSource(value);
  }, []);
  const setSecondarySaved = useCallback((value: string) => {
    secondarySavedRef.current = value;
    setSecondarySavedSource(value);
  }, []);
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
  }, [commitPrimaryText, commitSecondaryText]);
  /** Like commitOpenText, but never replaces a pane holding unsaved edits. */
  const commitCleanOpenText = useCallback((path: string, content: string) => {
    if (activeFileRef.current === path && sourceRef.current === savedSourceRef.current) {
      commitPrimaryText(content);
    }
    if (secondaryFileRef.current === path && secondarySourceRef.current === secondarySavedRef.current) {
      commitSecondaryText(content);
    }
  }, [commitPrimaryText, commitSecondaryText]);
  const showPrimaryText = useCallback((path: string, content: string) => {
    activeFileRef.current = path;
    setActiveFile(path);
    commitPrimaryText(content);
  }, [commitPrimaryText]);
  const showSecondaryText = useCallback((path: string | null, content = "", saved = content) => {
    secondaryFileRef.current = path;
    setSecondaryFile(path);
    setSecondarySourceLive(content);
    setSecondarySaved(saved);
  }, [setSecondarySaved, setSecondarySourceLive]);
  const showActiveAsset = useCallback((asset: AssetPreview | null) => {
    activeAssetRef.current = asset;
    setActiveAsset(asset);
  }, []);
  const showSecondaryAsset = useCallback((asset: AssetPreview | null) => {
    secondaryAssetRef.current = asset;
    setSecondaryAsset(asset);
  }, []);
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
    paperMarkdownRef.current = markdown;
    savedPaperMarkdownRef.current = savedMarkdown;
    paperBlogRef.current = blog;
    savedPaperBlogRef.current = savedBlog;
    setPaperMarkdown(markdown);
    setSavedPaperMarkdown(savedMarkdown);
    setPaperBlog(blog);
    setSavedPaperBlog(savedBlog);
  }, []);
  const markPaperSaved = useCallback((view: PaperView, content: string) => {
    if (view === "blog") {
      savedPaperBlogRef.current = content;
      setSavedPaperBlog(content);
    } else {
      savedPaperMarkdownRef.current = content;
      setSavedPaperMarkdown(content);
    }
  }, []);
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
  }, []);
  const paperBuffersDirty = useCallback(() => (
    paperMarkdownRef.current !== savedPaperMarkdownRef.current
    || paperBlogRef.current !== savedPaperBlogRef.current
  ), []);
  const primaryTextDirty = useCallback(() => sourceRef.current !== savedSourceRef.current, []);
  const secondaryTextDirty = useCallback(() => secondarySourceRef.current !== secondarySavedRef.current, []);

  const activePaperPath = activePaper ? paperDocumentPath(activePaper.arxivId, paperView) : null;
  const activePaperDirty = Boolean(activePaper) && (
    paperMarkdown !== savedPaperMarkdown || paperBlog !== savedPaperBlog
  );

  return {
    activeFile, setActiveFile, activeFileRef,
    source, setSource, sourceRef, setPrimarySource,
    savedSource, setSavedSource, savedSourceRef, setPrimarySaved,
    secondaryFile, setSecondaryFile, secondaryFileRef,
    secondarySource, setSecondarySource, secondarySourceRef, setSecondarySourceLive,
    secondarySavedSource, setSecondarySavedSource, secondarySavedRef, setSecondarySaved,
    activeAsset, activeAssetRef, showActiveAsset,
    secondaryAsset, secondaryAssetRef, showSecondaryAsset,
    activePaper, setActivePaper, activePaperPath, activePaperDirty,
    paperMarkdown, setPaperMarkdown, paperMarkdownRef,
    savedPaperMarkdown, setSavedPaperMarkdown, savedPaperMarkdownRef,
    paperBlog, setPaperBlog, paperBlogRef,
    savedPaperBlog, setSavedPaperBlog, savedPaperBlogRef,
    paperView, setPaperView, paperSide, setPaperSide,
    commitPrimaryText, commitSecondaryText, commitOpenText, commitCleanOpenText,
    showPrimaryText, showSecondaryText, clearSecondaryPane,
    setPaperBuffers, markPaperSaved, closePaper, remapOpenPaths,
    paperBuffersDirty, primaryTextDirty, secondaryTextDirty,
  };
}
