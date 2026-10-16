/**
 * The modal forms that create or rename something: the new-project dialog, the
 * rename dialog (files, folders, labels, citation keys, environments), the Add
 * papers sheet, the linked library's and the bibliography entry editor, with the literature
 * discovery panel that feeds them; the question an import asks about names
 * already in its folder; plus the TeX toolchain setup and package-install
 * dialogs.
 */
import { lazy, Suspense } from "react";
import { LazyMount } from "../components/lazy-mount";
import { CreateProjectDialog, RenameDialog } from "../project/project-dialogs";
import type { ProjectVenue, RenameTarget } from "../app-types";
import { TexDependencyInstaller } from "../build/tex-dependency-installer";
import { TexSetupWizard } from "../build/tex-setup-wizard";
import type { PaperSummary } from "../app-types";
import type { ReferenceImport } from "./use-reference-import";
import type { TexSetup } from "./use-tex-setup";
import type { ImportConflictRequest } from "./use-project-tree";

const BibEntryDialog = lazy(() =>
  import("../papers/bib-entry-dialog").then((module) => ({ default: module.BibEntryDialog })),
);
const AddPapersSheet = lazy(() =>
  import("../papers/add-papers-sheet").then((module) => ({ default: module.AddPapersSheet })),
);
const LinkedLibrarySheet = lazy(() =>
  import("../papers/linked-library-sheet").then((module) => ({ default: module.LinkedLibrarySheet })),
);
const ImportConflictDialog = lazy(() => import("../project/import-conflict-dialog"));
const LiteratureDiscoveryPanel = lazy(() =>
  import("../papers/literature-discovery-panel").then((module) => ({ default: module.LiteratureDiscoveryPanel })),
);

/** The new-project form; every edit clears the previous attempt's error. */
export type CreateProjectForm = { open: boolean; error: string | null; name: string; venue: ProjectVenue };

export function AppProjectDialogs({
  references, papers, importedArxivIds, createForm, updateCreateForm, createProject, rename, importConflict,
}: {
  references: ReferenceImport;
  papers: readonly PaperSummary[];
  importedArxivIds: Set<string>;
  createForm: CreateProjectForm;
  updateCreateForm: (update: Partial<CreateProjectForm>) => void;
  createProject: () => Promise<void>;
  rename: {
    target: RenameTarget | null;
    error: string | null;
    submit: (name: string) => Promise<void>;
    close: () => void;
  };
  importConflict: ImportConflictRequest | null;
}) {
  const { bibEntry, setLiteratureOpen, addSheet, linkedLibrary } = references;
  return (
    <>
      <LazyMount when={addSheet.open}>
        <AddPapersSheet
          key={addSheet.key}
          seed={addSheet.seed}
          papers={papers}
          importing={references.importing}
          onResolve={references.resolveBibQuery}
          onAdd={references.addPapers}
          onStop={references.cancelImport}
          onEnterManually={() => {
            references.closeAddSheet();
            references.enterBibEntryManually();
          }}
          onLinkLibrary={() => {
            references.closeAddSheet();
            references.openLinkedLibrary();
          }}
          onClose={references.closeAddSheet}
        />
      </LazyMount>
      <LazyMount when={linkedLibrary.open && Boolean(references.projectRoot)}>
        <LinkedLibrarySheet
          key={linkedLibrary.key}
          projectRoot={references.projectRoot ?? ""}
          bibliography={references.bibliography}
          onRewrite={references.rewriteBibliography}
          onClose={references.closeLinkedLibrary}
        />
      </LazyMount>
      <Suspense fallback={null}>
        <BibEntryDialog
          key={bibEntry.key}
          open={bibEntry.open}
          busy={bibEntry.busy}
          error={bibEntry.error}
          mode={bibEntry.mode}
          initialResolveQuery={bibEntry.resolveSeed}
          initialDraft={bibEntry.initial}
          onClose={() => {
            if (!bibEntry.busy) references.setBibEntry({ open: false });
          }}
          onResolve={references.resolveBibQuery}
          onSave={(draft, insertCite) => { void references.saveBibEntry(draft, insertCite); }}
        />
      </Suspense>
      <LazyMount when={references.literatureOpen}>
        <LiteratureDiscoveryPanel
          key={references.literatureSeed.key}
          initialQuery={references.literatureSeed.query}
          onClose={() => setLiteratureOpen(false)}
          importedIds={importedArxivIds}
          onImportArxiv={async (arxivId) => { await references.importReference(arxivId); }}
          onAddBib={(query) => {
            setLiteratureOpen(false);
            references.openBibEntry(query);
          }}
        />
      </LazyMount>
      {createForm.open && (
        <CreateProjectDialog
          projectName={createForm.name}
          setProjectName={(name) => updateCreateForm({ name })}
          projectVenue={createForm.venue}
          setProjectVenue={(venue) => updateCreateForm({ venue })}
          error={createForm.error}
          onCreate={createProject}
          onClose={() => updateCreateForm({ open: false })}
        />
      )}
      <LazyMount when={importConflict !== null}>
        {importConflict && <ImportConflictDialog request={importConflict} />}
      </LazyMount>
      {rename.target && (
        <RenameDialog target={rename.target} error={rename.error} onRename={rename.submit} onClose={rename.close} />
      )}
    </>
  );
}

export function TexSetupDialogs({ setup }: { setup: TexSetup }) {
  return (
    <>
      <TexSetupWizard
        open={setup.wizardOpen}
        report={setup.doctorReport}
        checking={setup.doctorBusy}
        paperToolsNeeded={setup.paperToolsNeeded}
        onClose={setup.closeWizard}
        onRecheck={() => setup.runDoctor({ openWizardIfMissing: true })}
      />
      <TexDependencyInstaller status={setup.install} onClose={setup.closeInstall} onRetry={setup.installDependency} />
    </>
  );
}
