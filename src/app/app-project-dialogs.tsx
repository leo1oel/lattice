/**
 * The modal forms that create or rename something: the new-project dialog, the
 * rename dialog (files, folders, labels, citation keys, environments), and the
 * bibliography entry editor with the literature discovery panel that feeds it;
 * plus the TeX toolchain setup and package-install dialogs.
 */
import { lazy, Suspense } from "react";
import { CreateProjectDialog, RenameDialog } from "../project/project-dialogs";
import type { ProjectVenue, RenameTarget } from "../app-types";
import { TexDependencyInstaller } from "../build/tex-dependency-installer";
import { TexSetupWizard } from "../build/tex-setup-wizard";
import type { ReferenceImport } from "./use-reference-import";
import type { TexSetup } from "./use-tex-setup";

const BibEntryDialog = lazy(() =>
  import("../papers/bib-entry-dialog").then((module) => ({ default: module.BibEntryDialog })),
);
const LiteratureDiscoveryPanel = lazy(() =>
  import("../papers/literature-discovery-panel").then((module) => ({ default: module.LiteratureDiscoveryPanel })),
);

/** The new-project form; every edit clears the previous attempt's error. */
export type CreateProjectForm = { open: boolean; error: string | null; name: string; venue: ProjectVenue };

export function AppProjectDialogs({ references, importedArxivIds, createForm, updateCreateForm, createProject, rename }: {
  references: ReferenceImport;
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
}) {
  const { bibEntry, setLiteratureOpen } = references;
  return (
    <>
      <Suspense fallback={null}>
        <BibEntryDialog
          key={bibEntry.key}
          open={bibEntry.open}
          busy={bibEntry.busy}
          resolving={bibEntry.resolving}
          error={bibEntry.error}
          mode={bibEntry.mode}
          initialResolveQuery={bibEntry.resolveSeed}
          initialDraft={bibEntry.initial}
          onClose={() => {
            if (!bibEntry.busy && !bibEntry.resolving) references.setBibEntry({ open: false });
          }}
          onResolve={references.resolveBibQuery}
          onSave={(draft, insertCite) => { void references.saveBibEntry(draft, insertCite); }}
        />
      </Suspense>
      {references.literatureOpen && (
        <Suspense fallback={null}>
          <LiteratureDiscoveryPanel
            onClose={() => setLiteratureOpen(false)}
            importedIds={importedArxivIds}
            onImportArxiv={async (arxivId) => { await references.importReference(arxivId); }}
            onAddBib={(query) => {
              setLiteratureOpen(false);
              references.openBibEntry(query);
            }}
          />
        </Suspense>
      )}
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
        onClose={() => setup.setWizardOpen(false)}
        onRecheck={() => setup.runDoctor({ openWizardIfMissing: true })}
      />
      <TexDependencyInstaller status={setup.install} onClose={setup.closeInstall} onRetry={setup.installDependency} />
    </>
  );
}
