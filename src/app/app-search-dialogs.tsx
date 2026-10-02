/**
 * The search surfaces.
 *
 * `AppSearchDialogs` holds the ones that resolve to a place in the open
 * document set — quick open, go to symbol, go to line, and the two insert
 * pickers. `AppProjectSearchDialogs` holds the two that run a query across the
 * whole project on the Rust side, find and replace, which need the project
 * generation refs to discard results from a project that has moved on.
 */
import type { RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { GotoLineDialog } from "../editor/goto-line-dialog";
import { QuickOpenDialog } from "../project/quick-open-dialog";
import { SearchPickerDialog, type SearchPickerItem } from "../components/ui/search-picker-dialog";
import { parsePaperLinkPath } from "../papers/paper-link";
import { flattenOutline, type OutlineNode } from "../editor/latex/latex-outline";
import { ProjectFindDialog, type ProjectFindHit } from "../project/project-find-dialog";
import type { ProjectSearch } from "./use-project-search";
import { ProjectReplaceDialog, type ReplacePreviewResult } from "../project/project-replace-dialog";
import { referenceKindLabel, type CitationInfo, type ReferenceInfo } from "../editor/latex/latex-text";
import { isProjectAssetFilePath, toMessage } from "../app-utils";
import { setNotice } from "./notify";
import { collectFilePaths } from "./workspace-restore";
import type {
  EditorPosition, FileNode, OpenProjectFile, ProjectSnapshot, RefreshProject, ReplaceResult,
} from "../app-types";

/** The navigation dialogs; at most one is open at a time. */
export type SearchDialog = "quick-open" | "goto-symbol" | "goto-line" | "cite" | "ref";

export function AppSearchDialogs({ open, setOpen, activeFile, openProjectFile, outlineNodes, liveReferences, ...props }: {
  open: SearchDialog | null;
  setOpen: (dialog: SearchDialog | null) => void;
  activeFile: string;
  files: FileNode[];
  citations: CitationInfo[];
  citationKeys: string[];
  editorPosition: EditorPosition | null;
  liveReferences: ReferenceInfo[];
  outlineNodes: OutlineNode[];
  source: string;
  openProjectAsset: (path: string) => Promise<boolean>;
  openProjectFile: OpenProjectFile;
  prewarmLikelyProjectFile: (path: string) => void;
  /** Insert `\cite{key}` or `\ref{key}` at the editor caret. */
  insertReference: (key: string, command: "cite" | "ref") => void;
  goToLine: (line: number) => void;
}) {
  const { t } = useLingui();
  const close = () => setOpen(null);
  /** Every pick closes the dialog on screen before acting on it. */
  const closeThen = <A extends unknown[]>(act: (...args: A) => void) => (...args: A) => {
    close();
    act(...args);
  };
  // Items are derived only for the dialog on screen.
  const symbolItems = (): SearchPickerItem[] => [
    ...flattenOutline(outlineNodes).filter((node) => node.kind !== "input").map((node) => ({
      id: `section:${node.id}`,
      label: node.title,
      detail: `${node.path || activeFile}:${node.line}`,
      group: t`Section`,
    })),
    ...liveReferences.map((reference) => {
      const title = reference.title || referenceKindLabel(reference.kind);
      return {
        id: `label:${reference.path}:${reference.label}`,
        label: reference.label,
        detail: `${reference.path}:${reference.line}${title !== reference.label ? ` · ${title}` : ""}`,
        group: t`Label`,
      };
    }),
  ];
  const insertPickers = [
    {
      command: "cite", title: t`Insert citation`, placeholder: t({ message: "Insert \\cite{…}" }),
      items: (): SearchPickerItem[] => props.citations.length
        ? props.citations.map((citation) => ({
          id: `cite:${citation.key}`,
          label: citation.key,
          detail: [citation.title, citation.authors, citation.year].filter(Boolean).join(" · "),
          group: t`Citation`,
        }))
        : props.citationKeys.map((key) => ({ id: `cite:${key}`, label: key, group: t`Citation` })),
    },
    {
      command: "ref", title: t`Insert reference`, placeholder: t({ message: "Insert \\ref{…}" }),
      items: (): SearchPickerItem[] => liveReferences.map((reference) => ({
        id: `ref:${reference.path}:${reference.label}`,
        label: reference.label,
        detail: `${reference.path}:${reference.line}`,
        group: t`Reference`,
      })),
    },
  ] as const;
  return (
    <>
      <QuickOpenDialog
        open={open === "quick-open"}
        paths={open === "quick-open" ? collectFilePaths(props.files, (node) => Boolean(node.path)) : []}
        onClose={close}
        onIntent={props.prewarmLikelyProjectFile}
        onOpen={closeThen((path) => {
          if (isProjectAssetFilePath(path)) void props.openProjectAsset(path);
          else void openProjectFile(path);
        })}
      />
      <SearchPickerDialog
        open={open === "goto-symbol"}
        title={t`Go to symbol`}
        placeholder={t`Go to section or label…`}
        items={open === "goto-symbol" ? symbolItems() : []}
        onClose={close}
        onSelect={closeThen((item) => {
          if (item.id.startsWith("section:")) {
            const node = flattenOutline(outlineNodes).find((entry) => `section:${entry.id}` === item.id);
            if (node) void openProjectFile(node.path || activeFile, node.line);
            return;
          }
          const reference = liveReferences.find((entry) => `label:${entry.path}:${entry.label}` === item.id);
          if (reference) void openProjectFile(reference.path, reference.line);
        })}
      />
      {insertPickers.map((picker) => (
        <SearchPickerDialog
          key={picker.command}
          open={open === picker.command}
          title={picker.title}
          placeholder={picker.placeholder}
          items={open === picker.command ? picker.items() : []}
          onClose={close}
          onSelect={closeThen((item) => props.insertReference(item.label, picker.command))}
        />
      ))}
      <GotoLineDialog
        open={open === "goto-line"}
        line={props.editorPosition?.line ?? 1}
        // Counted only while open: splitting a long document per keystroke is not free.
        maxLine={open === "goto-line" ? Math.max(1, props.source.split("\n").length) : 1}
        onClose={close}
        onGoto={closeThen(props.goToLine)}
      />
    </>
  );
}

export function AppProjectSearchDialogs({ search, captureProjectScope, projectRef, dirty, ...props }: {
  search: ProjectSearch;
  captureProjectScope: () => () => boolean;
  projectRef: RefObject<ProjectSnapshot | null>;
  /** Whether the open editor holds unsaved edits a replace must write first. */
  dirty: boolean;
  activeFile: string;
  loadFile: (path: string) => Promise<boolean>;
  openMarkdownProjectPath: (path: string) => void;
  openProjectFile: OpenProjectFile;
  refreshHistory: () => Promise<void>;
  refreshProject: RefreshProject;
  save: () => Promise<boolean>;
}) {
  const { t } = useLingui();
  const { find, setFind, replace, setReplace, searchGenerationRef } = search;
  /** Save a dirty buffer, then run one replace step with the dialog's busy/error state. */
  const runReplaceStep = async (step: () => Promise<void>, onError?: () => void) => {
    setReplace({ busy: true, error: null });
    try {
      if (dirty && !(await props.save())) return;
      await step();
    } catch (reason) {
      onError?.();
      setReplace({ error: toMessage(reason) });
    } finally {
      setReplace({ busy: false });
    }
  };
  return (
    <>
      <ProjectFindDialog
        open={find.open}
        busy={find.busy}
        error={find.error}
        hits={find.hits}
        onClose={() => {
          searchGenerationRef.current += 1;
          setFind({ open: false, busy: false, error: null, hits: [] });
        }}
        onSearch={async (query) => {
          const generation = ++searchGenerationRef.current;
          const projectRoot = projectRef.current?.root;
          if (!query.trim() || !projectRoot) {
            setFind({ hits: [], busy: false, error: null });
            return;
          }
          setFind({ busy: true, error: null });
          const ownsProject = captureProjectScope();
          const superseded = () => generation !== searchGenerationRef.current || !ownsProject();
          try {
            const hits = await invoke<ProjectFindHit[]>("search_project", { query });
            if (superseded()) return;
            setFind({ hits });
          } catch (reason) {
            if (superseded()) return;
            setFind({ hits: [], error: toMessage(reason) });
          } finally {
            if (generation === searchGenerationRef.current) setFind({ busy: false });
          }
        }}
        onOpenHit={(path, line) => {
          if (parsePaperLinkPath(path)) props.openMarkdownProjectPath(path);
          else void props.openProjectFile(path, line);
        }}
      />
      <ProjectReplaceDialog
        open={replace.open}
        busy={replace.busy}
        error={replace.error}
        preview={replace.preview}
        onClose={() => setReplace({ open: false, preview: null })}
        onOpenMatch={(path, line) => {
          void props.openProjectFile(path, line);
        }}
        onPreview={(query, options) => void runReplaceStep(async () => {
          setReplace({ preview: await invoke<ReplacePreviewResult>("preview_replace_in_project", { query, paths: null, ...options }) });
        }, () => setReplace({ preview: null }))}
        onReplace={(query, replacement, options) => void runReplaceStep(async () => {
          const result = await invoke<ReplaceResult>("replace_in_project", { query, replacement, paths: null, ...options });
          if (props.activeFile) await props.loadFile(props.activeFile);
          await props.refreshProject();
          await props.refreshHistory();
          setReplace({ open: false, preview: null });
          const replacements = result.replacements;
          const files = result.filesChanged.length;
          setNotice(!replacements
            ? t`No matches found.`
            : replacements === 1
              ? t`Replaced ${replacements} occurrence in ${files} file.`
              : files === 1
                ? t`Replaced ${replacements} occurrences in ${files} file.`
                : t`Replaced ${replacements} occurrences in ${files} files.`);
        })}
      />
    </>
  );
}
