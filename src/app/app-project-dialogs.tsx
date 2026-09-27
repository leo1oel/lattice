/**
 * The modal forms that create or rename something: the new-project dialog, the
 * rename dialog (files, folders, labels, citation keys, environments), and the
 * bibliography entry editor with the literature discovery panel that feeds it.
 */
import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import { type BibEntryDraft } from "../papers/bib-entry";
import type { ResolvedCitationDraft } from "../papers/bib-entry-dialog";
import { CreateProjectDialog, RenameDialog } from "../project/project-dialogs";
import type { ProjectVenue, RenameTarget } from "../app-types";

const BibEntryDialog = lazy(() =>
  import("../papers/bib-entry-dialog").then((module) => ({ default: module.BibEntryDialog })),
);
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
  const { bibEntryBusy, bibEntryResolving, setCreateError, setLiteratureOpen } = props;
  return (
    <>
      <Suspense fallback={null}>
        <BibEntryDialog
          key={props.bibEntryKey}
          open={props.bibEntryOpen}
          busy={bibEntryBusy}
          resolving={bibEntryResolving}
          error={props.bibEntryError}
          mode={props.bibEntryMode}
          initialResolveQuery={props.bibResolveSeed}
          initialDraft={props.bibEntryInitial}
          onClose={() => {
            if (!bibEntryBusy && !bibEntryResolving) props.setBibEntryOpen(false);
          }}
          onResolve={props.resolveBibQuery}
          onSave={(draft, insertCite) => { void props.saveBibEntry(draft, insertCite); }}
        />
      </Suspense>
      {props.literatureOpen && (
        <Suspense fallback={null}>
          <LiteratureDiscoveryPanel
            onClose={() => setLiteratureOpen(false)}
            importedIds={props.importedArxivIds}
            onImportArxiv={(arxivId) => props.importReferenceInput(arxivId)}
            onAddBib={(query) => {
              setLiteratureOpen(false);
              props.openBibEntryDialog(query);
            }}
          />
        </Suspense>
      )}
      {props.createOpen && (
        <CreateProjectDialog
          projectName={props.projectName}
          setProjectName={(value) => {
            props.setProjectName(value);
            setCreateError(null);
          }}
          projectVenue={props.projectVenue}
          setProjectVenue={(value) => {
            props.setProjectVenue(value);
            setCreateError(null);
          }}
          error={props.createError}
          onCreate={props.createProject}
          onClose={() => {
            setCreateError(null);
            props.setCreateOpen(false);
          }}
        />
      )}
      {props.renameTarget && (
        <RenameDialog
          target={props.renameTarget}
          error={props.renameError}
          onRename={props.submitRename}
          onClose={() => {
            props.setRenameError(null);
            props.setRenameTarget(null);
          }}
        />
      )}
    </>
  );
}
