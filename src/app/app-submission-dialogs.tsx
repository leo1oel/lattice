/**
 * The two dialogs that ready a manuscript for submission: Check references
 * (the bibliography audit, which updates entries in place) and Export for
 * arXiv.
 */
import { lazy, memo, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { LazyMount } from "../components/lazy-mount";
import type { CompileProject, ProjectSnapshot } from "../app-types";
import { showingErrors } from "./notify";
import type { OpenDocuments } from "./use-open-documents";
import type { useProjectLibrary } from "./use-project-library";

const BibliographyAudit = lazy(() =>
  import("../papers/bibliography-audit").then((module) => ({ default: module.BibliographyAudit })),
);
const ArxivExportDialog = lazy(() => import("../project/arxiv-export-dialog"));

type SubmissionDialogsProps = {
  project: ProjectSnapshot;
  /** The project the bibliography audit was last opened for, and whether it is open. */
  audit: { root: string | null; open: boolean; setOpen: (open: boolean) => void };
  arxivExport: { open: boolean; setOpen: (open: boolean) => void };
  documents: Pick<OpenDocuments, "save" | "openFile" | "accept">;
  refreshAfterSave: ReturnType<typeof useProjectLibrary>["refreshAfterSave"];
  openForMissingPaperTools: (failure: string) => Promise<void>;
  projectRootRef: RefObject<string | null>;
  /** Queues files written outside a save for upload to Overleaf. */
  externalEditsRef: RefObject<(paths: readonly string[]) => void>;
  compile: CompileProject;
};

const closed = ({ project, audit, arxivExport }: SubmissionDialogsProps) => audit.root !== project.root && !arxivExport.open;

/** Never opened in this project, it does not re-render with App, as LazyMount does for each dialog. */
export const AppSubmissionDialogs = memo(function AppSubmissionDialogs({
  project, audit, arxivExport, documents: { save, openFile, accept }, refreshAfterSave, openForMissingPaperTools,
  projectRootRef, externalEditsRef, compile,
}: SubmissionDialogsProps) {
  const { t } = useLingui();
  return (<>
    <LazyMount when={audit.root === project.root}>
      <BibliographyAudit
        key={project.root}
        open={audit.open}
        projectRoot={project.root}
        onClose={() => audit.setOpen(false)}
        onPrepare={save}
        onApplied={() => refreshAfterSave(project.root, false, true)}
        onMissingPaperTools={(failure) => void openForMissingPaperTools(failure)}
        onOpenSource={(path, line) => {
          // The report stays as it was behind the editor; reopening it resumes the queue.
          audit.setOpen(false);
          void showingErrors(() => openFile(path, { line }));
        }}
        onApply={async (entry, result) => {
          const root = project.root;
          if (!result.after) throw new Error(t`This reference cannot be updated.`);
          if (!await save()) throw new Error(t`Save pending edits before updating references.`);
          if (projectRootRef.current !== root) throw new Error(t`The project or its permissions changed. Check references again.`);
          await invoke("bibliography_audit_apply", { projectRoot: root, path: entry.path, key: entry.key, before: result.before, after: result.after });
          // The update was written straight to disk, not through a save, so
          // nothing would otherwise schedule its Overleaf upload. Left
          // unsynced, it meets the next unrelated sync as a local edit and
          // any Overleaf change to the bibliography in between turns into a
          // conflict.
          if (projectRootRef.current !== root) return;
          externalEditsRef.current([entry.path]);
          const content = await invoke<string>("read_project_file", { projectRoot: root, path: entry.path });
          if (projectRootRef.current !== root) return;
          accept(entry.path, content, "clean");
          // The drawer refreshes derived citation/history data once per
          // apply action (including bulk), outside the durable-write path.
        }}
      />
    </LazyMount>
    <LazyMount when={arxivExport.open}>
      <ArxivExportDialog
        key={project.root}
        projectRoot={project.root}
        projectName={project.manifest.name}
        save={save}
        build={() => compile()}
        onClose={() => arxivExport.setOpen(false)}
      />
    </LazyMount>
  </>);
}, (previous, next) => closed(previous) && closed(next));
