/**
 * The search surfaces.
 *
 * `AppSearchDialogs` holds the ones that resolve to a place in the open
 * document set — quick open, go to symbol, go to line, and the two insert
 * pickers. `AppProjectSearchDialogs` holds the two that run a query across the
 * whole project on the Rust side, find and replace, which need the project
 * generation refs to discard results from a project that has moved on.
 */
import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { GotoLineDialog } from "../editor/goto-line-dialog";
import { QuickOpenDialog } from "../project/quick-open-dialog";
import { SearchPickerDialog, type SearchPickerItem } from "../components/ui/search-picker-dialog";
import { parsePaperLinkPath } from "../papers/paper-link";
import { flattenOutline, type OutlineNode } from "../editor/latex/latex-outline";
import { ProjectFindDialog, type ProjectFindHit } from "../project/project-find-dialog";
import {
  fuseProjectSearchHits,
  semanticQueryEligible,
  type LocalSemanticSearchResponse,
  type LocalSemanticSearchStatus,
} from "../project/project-semantic-search";
import { ProjectReplaceDialog, type ReplacePreviewResult } from "../project/project-replace-dialog";
import { type ReferenceInfo } from "../editor/latex/latex-text";
import { isProjectAssetFilePath, toMessage } from "../app-utils";
import { setError, setNotice } from "./notify";
import type { CollabProjectControllerV2 } from "../collab/collab-project-v2";
import type {
  CanvasMode,
  EditorNavigation,
  EditorPaneId,
  EditorPosition,
  InsertSymbolCommand,
  ProjectSnapshot,
  ReplaceResult,
} from "../app-types";

export type AppSearchDialogsProps = {
  activeFile: string;
  citePickerItems: SearchPickerItem[];
  editorPosition: EditorPosition | null;
  gotoLineOpen: boolean;
  goToSymbolItems: SearchPickerItem[];
  goToSymbolOpen: boolean;
  liveReferences: ReferenceInfo[];
  openProjectAsset: (path: string) => Promise<boolean>;
  openProjectFile: (path: string, line?: number, targetPane?: EditorPaneId, options?: { revealSource?: boolean; }) => Promise<void>;
  outlineNodes: OutlineNode[];
  prewarmLikelyProjectFile: (path: string) => void;
  quickOpenOpen: boolean;
  quickOpenPaths: string[];
  refCitePicker: "ref" | "cite" | null;
  refPickerItems: SearchPickerItem[];
  setCanvasMode: Dispatch<SetStateAction<CanvasMode>>;
  setCiteInsertRequest: Dispatch<SetStateAction<{ key: string; command: InsertSymbolCommand; id: string; } | null>>;
  setEditorNavigation: Dispatch<SetStateAction<EditorNavigation | null>>;
  setGotoLineOpen: Dispatch<SetStateAction<boolean>>;
  setGoToSymbolOpen: Dispatch<SetStateAction<boolean>>;
  setQuickOpenOpen: Dispatch<SetStateAction<boolean>>;
  setRefCitePicker: Dispatch<SetStateAction<"ref" | "cite" | null>>;
  source: string;
};

export function AppSearchDialogs(props: AppSearchDialogsProps) {
  const { t } = useLingui();
  const {
    activeFile,
    citePickerItems,
    editorPosition,
    gotoLineOpen,
    goToSymbolItems,
    goToSymbolOpen,
    liveReferences,
    openProjectAsset,
    openProjectFile,
    outlineNodes,
    prewarmLikelyProjectFile,
    quickOpenOpen,
    quickOpenPaths,
    refCitePicker,
    refPickerItems,
    setCanvasMode,
    setCiteInsertRequest,
    setEditorNavigation,
    setGotoLineOpen,
    setGoToSymbolOpen,
    setQuickOpenOpen,
    setRefCitePicker,
    source,
  } = props;
  return (
    <>
      <QuickOpenDialog
        open={quickOpenOpen}
        paths={quickOpenPaths}
        onClose={() => setQuickOpenOpen(false)}
        onIntent={prewarmLikelyProjectFile}
        onOpen={(path) => {
          setQuickOpenOpen(false);
          if (isProjectAssetFilePath(path)) void openProjectAsset(path);
          else void openProjectFile(path);
        }}
      />
      <SearchPickerDialog
        open={goToSymbolOpen}
        title={t`Go to symbol`}
        placeholder={t`Go to section or label…`}
        items={goToSymbolItems}
        onClose={() => setGoToSymbolOpen(false)}
        onSelect={(item) => {
          setGoToSymbolOpen(false);
          if (item.id.startsWith("section:")) {
            const node = flattenOutline(outlineNodes).find((entry) => `section:${entry.id}` === item.id);
            if (node) void openProjectFile(node.path || activeFile, node.line);
            return;
          }
          const reference = liveReferences.find((entry) => `label:${entry.path}:${entry.label}` === item.id);
          if (reference) void openProjectFile(reference.path, reference.line);
        }}
      />
      <SearchPickerDialog
        open={refCitePicker === "cite"}
        title={t`Insert citation`}
        placeholder={t({ message: "Insert \\cite{…}" })}
        items={citePickerItems}
        onClose={() => setRefCitePicker(null)}
        onSelect={(item) => {
          setRefCitePicker(null);
          setCiteInsertRequest({ key: item.label, command: "cite", id: crypto.randomUUID() });
          setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
        }}
      />
      <SearchPickerDialog
        open={refCitePicker === "ref"}
        title={t`Insert reference`}
        placeholder={t({ message: "Insert \\ref{…}" })}
        items={refPickerItems}
        onClose={() => setRefCitePicker(null)}
        onSelect={(item) => {
          setRefCitePicker(null);
          setCiteInsertRequest({ key: item.label, command: "ref", id: crypto.randomUUID() });
          setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
        }}
      />
      <GotoLineDialog
        open={gotoLineOpen}
        line={editorPosition?.line ?? 1}
        maxLine={Math.max(1, source.split("\n").length)}
        onClose={() => setGotoLineOpen(false)}
        onGoto={(line) => {
          setGotoLineOpen(false);
          if (activeFile) {
            setEditorNavigation({ path: activeFile, line, id: crypto.randomUUID() });
          }
        }}
      />
    </>
  );
}

export type AppProjectSearchDialogsProps = {
  activeFile: string;
  loadFile: (path: string, options?: { restoreView?: boolean; revealSource?: boolean; expectedProjectRoot?: string; projectGeneration?: number; collabController?: CollabProjectControllerV2; gate?: Promise<boolean>; loadGeneration?: number; canCommit?: () => boolean; navigateToLine?: number; }) => Promise<boolean>;
  localSemanticSearchEnabled: boolean;
  localSemanticSearchStatus: LocalSemanticSearchStatus;
  openMarkdownProjectPath: (path: string) => void;
  openProjectFile: (path: string, line?: number, targetPane?: EditorPaneId, options?: { revealSource?: boolean; }) => Promise<void>;
  projectFindBusy: boolean;
  projectFindError: string | null;
  projectFindHits: ProjectFindHit[];
  projectFindOpen: boolean;
  projectFindSearchGenerationRef: RefObject<number>;
  projectOperationGenerationRef: RefObject<number>;
  projectRef: RefObject<ProjectSnapshot | null>;
  projectReplaceBusy: boolean;
  projectReplaceError: string | null;
  projectReplaceOpen: boolean;
  projectReplacePreview: ReplacePreviewResult | null;
  refreshHistory: () => Promise<void>;
  refreshProject: (scope?: { expectedRoot: string; generation: number; }) => Promise<ProjectSnapshot>;
  save: () => Promise<boolean>;
  savedSource: string;
  setLocalSemanticSearchStatus: Dispatch<SetStateAction<LocalSemanticSearchStatus>>;
  setProjectFindBusy: Dispatch<SetStateAction<boolean>>;
  setProjectFindError: Dispatch<SetStateAction<string | null>>;
  setProjectFindHits: Dispatch<SetStateAction<ProjectFindHit[]>>;
  setProjectFindOpen: Dispatch<SetStateAction<boolean>>;
  setProjectReplaceBusy: Dispatch<SetStateAction<boolean>>;
  setProjectReplaceError: Dispatch<SetStateAction<string | null>>;
  setProjectReplaceOpen: Dispatch<SetStateAction<boolean>>;
  setProjectReplacePreview: Dispatch<SetStateAction<ReplacePreviewResult | null>>;
  source: string;
};

export function AppProjectSearchDialogs(props: AppProjectSearchDialogsProps) {
  const {
    activeFile,
    loadFile,
    localSemanticSearchEnabled,
    localSemanticSearchStatus,
    openMarkdownProjectPath,
    openProjectFile,
    projectFindBusy,
    projectFindError,
    projectFindHits,
    projectFindOpen,
    projectFindSearchGenerationRef,
    projectOperationGenerationRef,
    projectRef,
    projectReplaceBusy,
    projectReplaceError,
    projectReplaceOpen,
    projectReplacePreview,
    refreshHistory,
    refreshProject,
    save,
    savedSource,
    setLocalSemanticSearchStatus,
    setProjectFindBusy,
    setProjectFindError,
    setProjectFindHits,
    setProjectFindOpen,
    setProjectReplaceBusy,
    setProjectReplaceError,
    setProjectReplaceOpen,
    setProjectReplacePreview,
    source,
  } = props;
  return (
    <>
      <ProjectFindDialog
        open={projectFindOpen}
        busy={projectFindBusy}
        error={projectFindError}
        hits={projectFindHits}
        semanticEnabled={localSemanticSearchEnabled}
        semanticStatus={localSemanticSearchStatus}
        onClose={() => {
          projectFindSearchGenerationRef.current += 1;
          setProjectFindOpen(false);
          setProjectFindBusy(false);
          setProjectFindError(null);
          setProjectFindHits([]);
        }}
        onSearch={(query) => {
          const generation = ++projectFindSearchGenerationRef.current;
          void (async () => {
            if (!query.trim()) {
              setProjectFindHits([]);
              setProjectFindBusy(false);
              setProjectFindError(null);
              return;
            }
            setProjectFindBusy(true);
            setProjectFindError(null);
            const projectRoot = projectRef.current?.root;
            const projectGeneration = projectOperationGenerationRef.current;
            if (!projectRoot) {
              setProjectFindHits([]);
              setProjectFindBusy(false);
              return;
            }
            try {
              const semanticPromise = localSemanticSearchEnabled
                && semanticQueryEligible(query)
                ? invoke<LocalSemanticSearchResponse>("semantic_search_project", {
                    projectRoot,
                    query,
                  }).catch(() => null)
                : Promise.resolve(null);
              const [results, semantic] = await Promise.all([
                invoke<ProjectFindHit[]>("search_project", { query }),
                semanticPromise,
              ]);
              if (
                generation !== projectFindSearchGenerationRef.current
                || projectGeneration !== projectOperationGenerationRef.current
                || projectRef.current?.root !== projectRoot
              ) return;
              if (semantic) setLocalSemanticSearchStatus(semantic.status);
              setProjectFindHits(fuseProjectSearchHits(results, query, semantic));
            } catch (reason) {
              if (
                generation !== projectFindSearchGenerationRef.current
                || projectGeneration !== projectOperationGenerationRef.current
                || projectRef.current?.root !== projectRoot
              ) return;
              setProjectFindHits([]);
              setProjectFindError(toMessage(reason));
            } finally {
              if (generation === projectFindSearchGenerationRef.current) {
                setProjectFindBusy(false);
              }
            }
          })();
        }}
        onOpenHit={(path, line) => {
          if (parsePaperLinkPath(path)) {
            openMarkdownProjectPath(path);
            return;
          }
          void openProjectFile(path, line);
        }}
      />
      <ProjectReplaceDialog
        open={projectReplaceOpen}
        busy={projectReplaceBusy}
        error={projectReplaceError}
        preview={projectReplacePreview}
        onClose={() => {
          setProjectReplaceOpen(false);
          setProjectReplacePreview(null);
        }}
        onOpenMatch={(path, line) => {
          void openProjectFile(path, line);
        }}
        onPreview={(query, options) => {
          void (async () => {
            setProjectReplaceBusy(true);
            setProjectReplaceError(null);
            try {
              if (source !== savedSource) {
                const saved = await save();
                if (!saved) return;
              }
              const preview = await invoke<ReplacePreviewResult>("preview_replace_in_project", {
                query,
                paths: null,
                matchCase: options.matchCase,
                useRegex: options.useRegex,
              });
              setProjectReplacePreview(preview);
            } catch (reason) {
              setProjectReplacePreview(null);
              setProjectReplaceError(toMessage(reason));
            } finally {
              setProjectReplaceBusy(false);
            }
          })();
        }}
        onReplace={(query, replacement, options) => {
          void (async () => {
            setProjectReplaceBusy(true);
            setProjectReplaceError(null);
            try {
              if (source !== savedSource) {
                const saved = await save();
                if (!saved) return;
              }
              const result = await invoke<ReplaceResult>("replace_in_project", {
                query,
                replacement,
                paths: null,
                matchCase: options.matchCase,
                useRegex: options.useRegex,
              });
              if (activeFile) await loadFile(activeFile);
              await refreshProject();
              await refreshHistory();
              setProjectReplaceOpen(false);
              setProjectReplacePreview(null);
              setError(null);
              setNotice(result.replacements
                ? `Replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} in ${result.filesChanged.length} file${result.filesChanged.length === 1 ? "" : "s"}.`
                : "No matches found.");
            } catch (reason) {
              setProjectReplaceError(toMessage(reason));
            } finally {
              setProjectReplaceBusy(false);
            }
          })();
        }}
      />
    </>
  );
}
