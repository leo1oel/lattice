/**
 * The modal forms that create or rename something: the new-project dialog, the
 * rename dialog (files, folders, labels, citation keys, environments), and the
 * bibliography entry editor with the literature discovery panel that feeds it.
 */
import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import { type BibEntryDraft } from "../papers/bib-entry";
import { BibEntryDialog, type ResolvedCitationDraft } from "../papers/bib-entry-dialog";
import { CreateProjectDialog, RenameDialog } from "../project/project-dialogs";
import type { ProjectVenue, RenameTarget } from "../app-types";

const LiteratureDiscoveryPanel = lazy(() =>
  import("../papers/literature-discovery-panel").then((module) => ({ default: module.LiteratureDiscoveryPanel })),
);

export type AppProjectDialogsProps = {
  bibEntryBusy: boolean;
  bibEntryError: string | null;
  bibEntryInitial: ResolvedCitationDraft | undefined;
  bibEntryKey: number;
  bibEntryMode: "add" | "edit";
  bibEntryOpen: boolean;
  bibEntryResolving: boolean;
  bibResolveSeed: string;
  createError: string | null;
  createOpen: boolean;
  createProject: () => Promise<void>;
  importedArxivIds: Set<string>;
  importReferenceInput: (input: string) => Promise<void>;
  literatureOpen: boolean;
  openBibEntryDialog: (resolveSeed?: string) => void;
  projectName: string;
  projectVenue: ProjectVenue;
  renameError: string | null;
  renameTarget: RenameTarget | null;
  resolveBibQuery: (query: string) => Promise<ResolvedCitationDraft | null>;
  saveBibEntry: (draft: BibEntryDraft, insertCite: boolean) => Promise<void>;
  setBibEntryOpen: Dispatch<SetStateAction<boolean>>;
  setCreateError: Dispatch<SetStateAction<string | null>>;
  setCreateOpen: Dispatch<SetStateAction<boolean>>;
  setLiteratureOpen: Dispatch<SetStateAction<boolean>>;
  setProjectName: Dispatch<SetStateAction<string>>;
  setProjectVenue: Dispatch<SetStateAction<ProjectVenue>>;
  setRenameError: Dispatch<SetStateAction<string | null>>;
  setRenameTarget: Dispatch<SetStateAction<RenameTarget | null>>;
  submitRename: (name: string) => Promise<void>;
};

export function AppProjectDialogs(props: AppProjectDialogsProps) {
  const {
    bibEntryBusy,
    bibEntryError,
    bibEntryInitial,
    bibEntryKey,
    bibEntryMode,
    bibEntryOpen,
    bibEntryResolving,
    bibResolveSeed,
    createError,
    createOpen,
    createProject,
    importedArxivIds,
    importReferenceInput,
    literatureOpen,
    openBibEntryDialog,
    projectName,
    projectVenue,
    renameError,
    renameTarget,
    resolveBibQuery,
    saveBibEntry,
    setBibEntryOpen,
    setCreateError,
    setCreateOpen,
    setLiteratureOpen,
    setProjectName,
    setProjectVenue,
    setRenameError,
    setRenameTarget,
    submitRename,
  } = props;
  return (
    <>
      <BibEntryDialog
        key={bibEntryKey}
        open={bibEntryOpen}
        busy={bibEntryBusy}
        resolving={bibEntryResolving}
        error={bibEntryError}
        mode={bibEntryMode}
        initialResolveQuery={bibResolveSeed}
        initialDraft={bibEntryInitial}
        onClose={() => {
          if (!bibEntryBusy && !bibEntryResolving) setBibEntryOpen(false);
        }}
        onResolve={resolveBibQuery}
        onSave={(draft, insertCite) => { void saveBibEntry(draft, insertCite); }}
      />
      {literatureOpen && (
        <Suspense fallback={null}>
          <LiteratureDiscoveryPanel
            onClose={() => setLiteratureOpen(false)}
            importedIds={importedArxivIds}
            onImportArxiv={(arxivId) => importReferenceInput(arxivId)}
            onAddBib={(query) => {
              setLiteratureOpen(false);
              openBibEntryDialog(query);
            }}
          />
        </Suspense>
      )}
      {createOpen && (
        <CreateProjectDialog
          projectName={projectName}
          setProjectName={(value) => {
            setProjectName(value);
            setCreateError(null);
          }}
          projectVenue={projectVenue}
          setProjectVenue={(value) => {
            setProjectVenue(value);
            setCreateError(null);
          }}
          error={createError}
          onCreate={createProject}
          onClose={() => {
            setCreateError(null);
            setCreateOpen(false);
          }}
        />
      )}
      {renameTarget && (
        <RenameDialog
          target={renameTarget}
          error={renameError}
          onRename={submitRename}
          onClose={() => {
            setRenameError(null);
            setRenameTarget(null);
          }}
        />
      )}
    </>
  );
}
