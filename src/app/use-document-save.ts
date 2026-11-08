import { useCallback, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { formatBibDocument } from "../papers/bib-format";
import { notifyError } from "../telemetry/app-notify";
import { showWarning } from "./notify";
import type { EditorWriteResult } from "./open-slide-writes";
import { paperDocumentPath } from "./paper-documents";
import { UNREAD_DISK_VERSION } from "./read-document";
import { createSaveActivity, NOTHING_SAVED, trackSave, type SaveStatus } from "./save-activity";
import { isVanished, type DocumentStore } from "./use-document-store";
import { noteHostFileWrites } from "../agent/agent-host-writes";

/**
 * Write the document in front to disk: the text file's buffer, or both of the
 * open Paper's reading files. Saves run one at a time (save-activity.ts), and
 * `saveStatus` is the last write's outcome in the current project.
 */
export function useDocumentSave(store: DocumentStore) {
  // Left to React: both callbacks are explicit useCallbacks and the caller
  // destructures the result at once, so compiling it memoized nothing new
  // while doubling each dep check in eager JS.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a React Compiler directive
  "use no memo";
  const { t } = useLingui();
  const {
    depsRef, projectRoot, renderedRef, fileRef, textRef, savedRef, setText, takeOutsideText, setSavedText,
    paperMarkdownRef, savedPaperMarkdownRef, setSavedPaperMarkdown, paperBlogRef, savedPaperBlogRef, setSavedPaperBlog,
    diskVersionRef, vanishedRef,
  } = store;
  // Saves in flight, which the disk poll waits out.
  const saveActivityRef = useRef(createSaveActivity());
  // Kept with the project it describes: another project starts from nothing saved.
  const [saveRecord, setSaveStatus] = useState<SaveStatus & { root?: string }>(NOTHING_SAVED);
  const saveStatus: SaveStatus = saveRecord.root === projectRoot ? saveRecord : NOTHING_SAVED;

  const saveContents = useCallback(async (): Promise<boolean> => {
    const { project: current, paper: openPaper, asset: openAsset, file: activeFile } = renderedRef.current;
    if (!current) return true;
    // The file the write under way is for: a failed save names the document
    // that could not be written, which is not the retained file when a Paper
    // is in front (its two reading files have buffers of their own).
    let writing: string | null = null;
    const write = async () => {
      const primaryPath = fileRef.current;
      const primarySource = textRef.current;
      const primarySavedSource = savedRef.current;
      const paperBuffers = [
        ["fulltext", paperMarkdownRef.current, savedPaperMarkdownRef.current],
        ["blog", paperBlogRef.current, savedPaperBlogRef.current],
      ] as const;
      const writtenPaths: string[] = [];
      if (!openPaper && !openAsset && primaryPath && primarySource !== primarySavedSource) {
        // The file left its path while these edits were unsaved. Writing them
        // waits for the writer's choice, offered again here rather than as a
        // failure each autosave repeats, unless they chose to recreate it:
        // then there is no file to merge with (see vanished-file-wait.ts).
        const vanished = isVanished(vanishedRef.current, current.root, primaryPath) ? vanishedRef.current : null;
        if (vanished && !vanished.recreate) {
          vanished.announce();
          return false;
        }
        // Only what this save changed: the writer's layout of every other entry stays.
        const content = /\.bib$/i.test(primaryPath) ? formatBibDocument(primarySource, primarySavedSource) : primarySource;
        // Format before awaiting disk I/O: subsequent typing must remain a dirty
        // edit, not be replaced by the formatted snapshot when the write returns.
        if (content !== primarySource) setText(content);
        writing = primaryPath;
        const writeResult = await invoke<EditorWriteResult>("write_project_file", {
          path: primaryPath, content, baseContent: vanished ? undefined : primarySavedSource, projectRoot: current.root,
        });
        if (vanished && vanishedRef.current === vanished) vanishedRef.current = null;
        const writtenSource = writeResult?.content ?? content;
        const sameFile = fileRef.current === primaryPath;
        // A merge brought in edits made outside: not the writer's to undo.
        if (writtenSource !== content && sameFile && textRef.current === content) takeOutsideText(writtenSource);
        if (writeResult?.hadConflicts) {
          const path = primaryPath;
          showWarning(t({ message: `Kept overlapping external edits in ${path} with conflict markers.` }));
        }
        // The saved text is the base the next save merges against, so it must
        // be what the buffer grew from. When this save merged in an outside
        // edit (an Overleaf pull that landed while the save waited for the
        // sync) and typing went on meanwhile, the buffer grew from `content`,
        // not from the merged file: recording the merge would make the next
        // save write the buffer straight over it, losing the outside edit.
        // Keeping `content` lets that save merge again instead.
        const typedOn = sameFile && textRef.current !== content;
        setSavedText(writtenSource !== content && typedOn ? content : writtenSource);
        // Force the detector to inspect the next filesystem version. An Agent
        // may finish another atomic write after the backend response but before
        // a post-save stat; recording that newer mtime without reading it would
        // hide the Agent edit indefinitely.
        diskVersionRef.current = UNREAD_DISK_VERSION;
        writtenPaths.push(primaryPath);
      }
      for (const [view, content, savedContent] of openPaper ? paperBuffers : []) {
        if (content === null || content === savedContent) continue;
        const path = paperDocumentPath(openPaper!.arxivId, view);
        writing = path;
        await invoke("write_project_file", { path, content, projectRoot: current.root });
        if (view === "blog") setSavedPaperBlog(content);
        else setSavedPaperMarkdown(content);
        writtenPaths.push(path);
      }
      if (!writtenPaths.length) return true;
      // The writer's typing, landing beside an agent's turn, is not the agent's to undo.
      noteHostFileWrites(current.root, writtenPaths);
      setSaveStatus({ phase: "saved", at: Date.now(), path: writtenPaths[0]!, root: current.root });
      // Saving must only wait for durable writes. The derived sidebars are
      // useful, but making file switches and builds wait on six independent
      // project scans turned every save into a visible pause.
      depsRef.current.onSaved(current.root, writtenPaths);
      return true;
    };
    return write().catch((reason: unknown) => {
      // Autosave runs constantly, so this path gets a plain notification rather
      // than a `logAction` trace — a start line per keystroke pause would bury
      // everything else in the log.
      const failedPath = writing ?? (activeFile || null);
      notifyError(t`Save`, failedPath ? t`Could not save ${failedPath}` : t`Could not save the project`, { detail: toMessage(reason) });
      setSaveStatus({ phase: "failed", at: Date.now(), path: failedPath, error: toMessage(reason), root: current.root });
      return false;
    });
  }, [
    depsRef, diskVersionRef, fileRef, paperBlogRef, paperMarkdownRef, renderedRef, savedPaperBlogRef, savedPaperMarkdownRef,
    savedRef, setSavedText, setSavedPaperBlog, setSavedPaperMarkdown, setText, t, takeOutsideText, textRef, vanishedRef,
  ]);
  const save = useCallback(
    () => trackSave(saveActivityRef.current, renderedRef.current.project?.root, setSaveStatus, saveContents),
    [renderedRef, saveContents],
  );

  return { save, saveStatus, saveActivityRef };
}
