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
import {
  fuseProjectSearchHits,
  semanticQueryEligible,
  type LocalSemanticSearchResponse,
} from "../project/project-semantic-search";
import type { useLocalSemanticSearch } from "./use-local-semantic-search";
import type { ProjectSearch } from "./use-project-search";
import { ProjectReplaceDialog, type ReplacePreviewResult } from "../project/project-replace-dialog";
import type { CitationInfo, ReferenceInfo } from "../editor/latex/latex-text";
import { isProjectAssetFilePath, toMessage } from "../app-utils";
import { setError, setNotice } from "./notify";
import type {
  EditorPosition, FileNode, OpenProjectFile, ProjectSnapshot, RefreshProject, ReplaceResult,
} from "../app-types";

/** The navigation dialogs; at most one is open at a time. */
export type SearchDialog = "quick-open" | "goto-symbol" | "goto-line" | "cite" | "ref";

function collectQuickOpenPaths(nodes: FileNode[], paths: string[] = []): string[] {
  for (const node of nodes) {
    const isDirectory = node.kind === "directory" || node.contentKind === "directory";
    if (!isDirectory && node.path) paths.push(node.path);
    if (node.children.length) collectQuickOpenPaths(node.children, paths);
  }
  return paths;
}

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
  // Items are derived only for the dialog on screen.
  const symbolItems = (): SearchPickerItem[] => [
    ...flattenOutline(outlineNodes).filter((node) => node.kind !== "input").map((node) => ({
      id: `section:${node.id}`,
      label: node.title,
      detail: `${node.path || activeFile}:${node.line}`,
      group: "Section",
    })),
    ...liveReferences.map((reference) => ({
      id: `label:${reference.path}:${reference.label}`,
      label: reference.label,
      detail: `${reference.path}:${reference.line}${reference.title && reference.title !== reference.label ? ` · ${reference.title}` : ""}`,
      group: "Label",
    })),
  ];
  const insertPickers = [
    {
      command: "cite", title: t`Insert citation`, placeholder: t({ message: "Insert \\cite{…}" }),
      items: (): SearchPickerItem[] => props.citations.length
        ? props.citations.map((citation) => ({
          id: `cite:${citation.key}`,
          label: citation.key,
          detail: [citation.title, citation.authors, citation.year].filter(Boolean).join(" · "),
          group: "Citation",
        }))
        : props.citationKeys.map((key) => ({ id: `cite:${key}`, label: key, group: "Citation" })),
    },
    {
      command: "ref", title: t`Insert reference`, placeholder: t({ message: "Insert \\ref{…}" }),
      items: (): SearchPickerItem[] => liveReferences.map((reference) => ({
        id: `ref:${reference.path}:${reference.label}`,
        label: reference.label,
        detail: `${reference.path}:${reference.line}`,
        group: "Reference",
      })),
    },
  ] as const;
  return (
    <>
      <QuickOpenDialog
        open={open === "quick-open"}
        paths={open === "quick-open" ? collectQuickOpenPaths(props.files) : []}
        onClose={close}
        onIntent={props.prewarmLikelyProjectFile}
        onOpen={(path) => {
          close();
          if (isProjectAssetFilePath(path)) void props.openProjectAsset(path);
          else void openProjectFile(path);
        }}
      />
      <SearchPickerDialog
        open={open === "goto-symbol"}
        title={t`Go to symbol`}
        placeholder={t`Go to section or label…`}
        items={open === "goto-symbol" ? symbolItems() : []}
        onClose={close}
        onSelect={(item) => {
          close();
          if (item.id.startsWith("section:")) {
            const node = flattenOutline(outlineNodes).find((entry) => `section:${entry.id}` === item.id);
            if (node) void openProjectFile(node.path || activeFile, node.line);
            return;
          }
          const reference = liveReferences.find((entry) => `label:${entry.path}:${entry.label}` === item.id);
          if (reference) void openProjectFile(reference.path, reference.line);
        }}
      />
      {insertPickers.map((picker) => (
        <SearchPickerDialog
          key={picker.command}
          open={open === picker.command}
          title={picker.title}
          placeholder={picker.placeholder}
          items={open === picker.command ? picker.items() : []}
          onClose={close}
          onSelect={(item) => {
            close();
            props.insertReference(item.label, picker.command);
          }}
        />
      ))}
      <GotoLineDialog
        open={open === "goto-line"}
        line={props.editorPosition?.line ?? 1}
        maxLine={Math.max(1, props.source.split("\n").length)}
        onClose={close}
        onGoto={(line) => {
          close();
          props.goToLine(line);
        }}
      />
    </>
  );
}

export function AppProjectSearchDialogs({ search, semanticSearch, captureProjectScope, projectRef, dirty, ...props }: {
  search: ProjectSearch;
  semanticSearch: ReturnType<typeof useLocalSemanticSearch>;
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
  const { find, setFind, replace, setReplace, searchGenerationRef } = search;
  /** Save a dirty buffer, then run one replace step with the dialog's busy/error state. */
  const runReplaceStep = (step: () => Promise<void>, onError?: () => void) => {
    void (async () => {
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
    })();
  };
  return (
    <>
      <ProjectFindDialog
        open={find.open}
        busy={find.busy}
        error={find.error}
        hits={find.hits}
        semanticEnabled={semanticSearch.enabled}
        semanticStatus={semanticSearch.status}
        onClose={() => {
          searchGenerationRef.current += 1;
          setFind({ open: false, busy: false, error: null, hits: [] });
        }}
        onSearch={(query) => {
          const generation = ++searchGenerationRef.current;
          void (async () => {
            if (!query.trim()) {
              setFind({ hits: [], busy: false, error: null });
              return;
            }
            setFind({ busy: true, error: null });
            const projectRoot = projectRef.current?.root;
            if (!projectRoot) {
              setFind({ hits: [], busy: false });
              return;
            }
            const ownsProject = captureProjectScope();
            const superseded = () => generation !== searchGenerationRef.current || !ownsProject();
            try {
              const semanticPromise = semanticSearch.enabled && semanticQueryEligible(query)
                ? invoke<LocalSemanticSearchResponse>("semantic_search_project", { projectRoot, query }).catch(() => null)
                : Promise.resolve(null);
              const [results, semantic] = await Promise.all([
                invoke<ProjectFindHit[]>("search_project", { query }),
                semanticPromise,
              ]);
              if (superseded()) return;
              if (semantic) semanticSearch.setStatus(semantic.status);
              setFind({ hits: fuseProjectSearchHits(results, query, semantic) });
            } catch (reason) {
              if (superseded()) return;
              setFind({ hits: [], error: toMessage(reason) });
            } finally {
              if (generation === searchGenerationRef.current) setFind({ busy: false });
            }
          })();
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
        onPreview={(query, options) => runReplaceStep(async () => {
          setReplace({ preview: await invoke<ReplacePreviewResult>("preview_replace_in_project", {
            query,
            paths: null,
            matchCase: options.matchCase,
            useRegex: options.useRegex,
          }) });
        }, () => setReplace({ preview: null }))}
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
          setReplace({ open: false, preview: null });
          setError(null);
          setNotice(result.replacements
            ? `Replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} in ${result.filesChanged.length} file${result.filesChanged.length === 1 ? "" : "s"}.`
            : "No matches found.");
        })}
      />
    </>
  );
}
