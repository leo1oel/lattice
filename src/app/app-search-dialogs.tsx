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
import type {
  CanvasMode,
  EditorNavigation,
  EditorPosition,
  InsertSymbolCommand,
  OpenProjectFile,
  ProjectSnapshot,
  RefreshProject,
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
  openProjectFile: OpenProjectFile;
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
  const { activeFile, openProjectFile, setRefCitePicker } = props;
  const insertPickers = [
    { command: "cite", title: t`Insert citation`, placeholder: t({ message: "Insert \\cite{…}" }), items: props.citePickerItems },
    { command: "ref", title: t`Insert reference`, placeholder: t({ message: "Insert \\ref{…}" }), items: props.refPickerItems },
  ] as const;
  return (
    <>
      <QuickOpenDialog
        open={props.quickOpenOpen}
        paths={props.quickOpenPaths}
        onClose={() => props.setQuickOpenOpen(false)}
        onIntent={props.prewarmLikelyProjectFile}
        onOpen={(path) => {
          props.setQuickOpenOpen(false);
          if (isProjectAssetFilePath(path)) void props.openProjectAsset(path);
          else void openProjectFile(path);
        }}
      />
      <SearchPickerDialog
        open={props.goToSymbolOpen}
        title={t`Go to symbol`}
        placeholder={t`Go to section or label…`}
        items={props.goToSymbolItems}
        onClose={() => props.setGoToSymbolOpen(false)}
        onSelect={(item) => {
          props.setGoToSymbolOpen(false);
          if (item.id.startsWith("section:")) {
            const node = flattenOutline(props.outlineNodes).find((entry) => `section:${entry.id}` === item.id);
            if (node) void openProjectFile(node.path || activeFile, node.line);
            return;
          }
          const reference = props.liveReferences.find((entry) => `label:${entry.path}:${entry.label}` === item.id);
          if (reference) void openProjectFile(reference.path, reference.line);
        }}
      />
      {insertPickers.map((picker) => (
        <SearchPickerDialog
          key={picker.command}
          open={props.refCitePicker === picker.command}
          title={picker.title}
          placeholder={picker.placeholder}
          items={picker.items}
          onClose={() => setRefCitePicker(null)}
          onSelect={(item) => {
            setRefCitePicker(null);
            props.setCiteInsertRequest({ key: item.label, command: picker.command, id: crypto.randomUUID() });
            props.setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
          }}
        />
      ))}
      <GotoLineDialog
        open={props.gotoLineOpen}
        line={props.editorPosition?.line ?? 1}
        maxLine={Math.max(1, props.source.split("\n").length)}
        onClose={() => props.setGotoLineOpen(false)}
        onGoto={(line) => {
          props.setGotoLineOpen(false);
          if (activeFile) props.setEditorNavigation({ path: activeFile, line, id: crypto.randomUUID() });
        }}
      />
    </>
  );
}

export type AppProjectSearchDialogsProps = {
  activeFile: string;
  loadFile: (path: string) => Promise<boolean>;
  localSemanticSearchEnabled: boolean;
  localSemanticSearchStatus: LocalSemanticSearchStatus;
  openMarkdownProjectPath: (path: string) => void;
  openProjectFile: OpenProjectFile;
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
  refreshProject: RefreshProject;
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
    projectFindSearchGenerationRef: searchGenerationRef,
    projectOperationGenerationRef,
    projectRef,
    setProjectFindBusy,
    setProjectFindError,
    setProjectFindHits,
    setProjectReplaceBusy,
    setProjectReplaceError,
    setProjectReplacePreview,
  } = props;
  /** Save a dirty buffer, then run one replace step with the dialog's busy/error state. */
  const runReplaceStep = (step: () => Promise<void>, onError?: () => void) => {
    void (async () => {
      setProjectReplaceBusy(true);
      setProjectReplaceError(null);
      try {
        if (props.source !== props.savedSource && !(await props.save())) return;
        await step();
      } catch (reason) {
        onError?.();
        setProjectReplaceError(toMessage(reason));
      } finally {
        setProjectReplaceBusy(false);
      }
    })();
  };
  return (
    <>
      <ProjectFindDialog
        open={props.projectFindOpen}
        busy={props.projectFindBusy}
        error={props.projectFindError}
        hits={props.projectFindHits}
        semanticEnabled={props.localSemanticSearchEnabled}
        semanticStatus={props.localSemanticSearchStatus}
        onClose={() => {
          searchGenerationRef.current += 1;
          props.setProjectFindOpen(false);
          setProjectFindBusy(false);
          setProjectFindError(null);
          setProjectFindHits([]);
        }}
        onSearch={(query) => {
          const generation = ++searchGenerationRef.current;
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
            const superseded = () => generation !== searchGenerationRef.current
              || projectGeneration !== projectOperationGenerationRef.current
              || projectRef.current?.root !== projectRoot;
            try {
              const semanticPromise = props.localSemanticSearchEnabled && semanticQueryEligible(query)
                ? invoke<LocalSemanticSearchResponse>("semantic_search_project", { projectRoot, query }).catch(() => null)
                : Promise.resolve(null);
              const [results, semantic] = await Promise.all([
                invoke<ProjectFindHit[]>("search_project", { query }),
                semanticPromise,
              ]);
              if (superseded()) return;
              if (semantic) props.setLocalSemanticSearchStatus(semantic.status);
              setProjectFindHits(fuseProjectSearchHits(results, query, semantic));
            } catch (reason) {
              if (superseded()) return;
              setProjectFindHits([]);
              setProjectFindError(toMessage(reason));
            } finally {
              if (generation === searchGenerationRef.current) setProjectFindBusy(false);
            }
          })();
        }}
        onOpenHit={(path, line) => {
          if (parsePaperLinkPath(path)) props.openMarkdownProjectPath(path);
          else void props.openProjectFile(path, line);
        }}
      />
      <ProjectReplaceDialog
        open={props.projectReplaceOpen}
        busy={props.projectReplaceBusy}
        error={props.projectReplaceError}
        preview={props.projectReplacePreview}
        onClose={() => {
          props.setProjectReplaceOpen(false);
          setProjectReplacePreview(null);
        }}
        onOpenMatch={(path, line) => {
          void props.openProjectFile(path, line);
        }}
        onPreview={(query, options) => runReplaceStep(async () => {
          setProjectReplacePreview(await invoke<ReplacePreviewResult>("preview_replace_in_project", {
            query,
            paths: null,
            matchCase: options.matchCase,
            useRegex: options.useRegex,
          }));
        }, () => setProjectReplacePreview(null))}
        onReplace={(query, replacement, options) => runReplaceStep(async () => {
          const result = await invoke<ReplaceResult>("replace_in_project", {
            query,
            replacement,
            paths: null,
            matchCase: options.matchCase,
            useRegex: options.useRegex,
          });
          if (props.activeFile) await props.loadFile(props.activeFile);
          await props.refreshProject();
          await props.refreshHistory();
          props.setProjectReplaceOpen(false);
          setProjectReplacePreview(null);
          setError(null);
          setNotice(result.replacements
            ? `Replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} in ${result.filesChanged.length} file${result.filesChanged.length === 1 ? "" : "s"}.`
            : "No matches found.");
        })}
      />
    </>
  );
}
