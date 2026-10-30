import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AssetPreview } from "../app-types";
import { isProjectFileMissing } from "../pdf/project-pdf-refusals";
import { PDF_RECHECK_MS, useProjectPdfWatch } from "../pdf/use-project-pdf-watch";
import type { SaveActivity } from "./save-activity";
import type { DocumentStore } from "./use-document-store";

/** How often the open file is checked for an edit made behind the editor. */
const DISK_POLL_MS = 2500;

/**
 * Keep the open documents in step with disk: an external edit reloads a clean
 * text buffer, and a rewritten project PDF swaps to its new version.
 */
export function useDocumentDiskSync(store: DocumentStore, saveActivityRef: RefObject<SaveActivity>) {
  const {
    depsRef, autoBuildEnabled, project, file, asset, paper, savedRef, textRef, diskMtimeRef, accept,
    assetRef, setAsset, captureProjectScope,
  } = store;
  // A PDF removed from the project while it is open.
  const [missingAsset, setMissingAsset] = useState<AssetPreview | null>(null);
  const viewerRecheckAtRef = useRef(0);

  // An external edit to the open file: record its mtime the first time, then
  // reload a newer version into a clean buffer.
  useEffect(() => {
    if (!project || !file || asset || paper) return;
    let cancelled = false;
    const poll = async () => {
      if (saveActivityRef.current.pending) return;
      const saveGenerationAtStart = saveActivityRef.current.generation;
      // Disk reads may finish after our own autosave or a live delivery.
      // Such a snapshot is not a new external edit and must not rewind the
      // buffer or suspend Overleaf OT. Leave mtime unconsumed so we retry.
      const readIsCurrent = () => !cancelled
        && !saveActivityRef.current.pending
        && saveActivityRef.current.generation === saveGenerationAtStart;
      const saved = savedRef.current;
      const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", { path: file });
      if (!readIsCurrent() || !stat.exists || savedRef.current !== saved) return;
      if (diskMtimeRef.current == null) {
        diskMtimeRef.current = stat.mtimeMs;
        return;
      }
      if (stat.mtimeMs <= diskMtimeRef.current) return;
      const content = await invoke<string>("read_project_file", { path: file });
      if (!readIsCurrent() || savedRef.current !== saved) return;
      diskMtimeRef.current = stat.mtimeMs;
      if (content === saved) return;
      depsRef.current.onDiskEdit(file);
      if (textRef.current !== savedRef.current) return;
      accept(file, content);
      if (depsRef.current.autoBuild.enabled) depsRef.current.autoBuild.afterDiskEdit();
    };
    const timer = window.setInterval(() => {
      void poll().catch(() => {
        // Ignore transient filesystem races while the editor is open.
      });
    }, DISK_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accept, asset, autoBuildEnabled, depsRef, diskMtimeRef, file, paper, project, saveActivityRef, savedRef, textRef]);

  // A rewrite on disk hands the open project PDF the new version, keeping its
  // page and zoom across the swap (see useProjectPdfWatch). The viewer also
  // asks at once when a read finds the file changed. A file removed from the
  // project stays open with a notice; a rebuild that deletes and then
  // rewrites it brings the new version back in at the same page.
  const recheckAsset = useCallback(() => {
    const shown = assetRef.current;
    if (!shown?.ranges) return;
    const path = shown.path;
    const ownsProject = captureProjectScope();
    void invoke<AssetPreview>("read_project_asset", { path })
      .then((preview) => {
        const current = assetRef.current;
        if (!ownsProject() || current?.path !== path || !preview.ranges) return;
        if (preview.ranges.version !== current.ranges?.version) setAsset(preview);
        else setMissingAsset((missing) => (missing === current ? null : missing));
      })
      .catch((reason: unknown) => {
        // A file caught mid-write is read again on the next tick.
        if (ownsProject() && assetRef.current === shown && isProjectFileMissing(reason)) setMissingAsset(shown);
      });
  }, [assetRef, captureProjectScope, setAsset]);
  /** The viewer found its file changed: answered at most once per poll interval. */
  const onAssetChanged = useCallback(() => {
    const now = Date.now();
    if (now - viewerRecheckAtRef.current < PDF_RECHECK_MS) return;
    viewerRecheckAtRef.current = now;
    recheckAsset();
  }, [recheckAsset]);
  const assetMissing = asset !== null && asset === missingAsset;
  const pdfPath = asset?.ranges ? asset.path : null;
  useProjectPdfWatch(project?.root, pdfPath, assetMissing, recheckAsset);

  return { onAssetChanged, assetMissing };
}
