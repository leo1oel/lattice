import { useState } from "react";
import {
  Cloud,
  FileArchive,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  Radio,
  Settings,
  Sparkles,
} from "lucide-react";
import { MorphIcon, MotionButton } from "./motion";
import { InfinityLoader } from "./components/ui/activity-icons";
import { Button } from "./components/ui/button";
import { buttonClassName } from "./components/ui/button-styles";
import { Input } from "./components/ui/input";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu";
import { type ProjectVenue, type RenameTarget } from "./app-types";
import { type RecentProject } from "./app-settings";
import { beginWindowDrag, toggleWindowFullscreen } from "./app-utils";
import { ModalDialog } from "./components/ui/modal-dialog";

export function Welcome(props: {
  busyLabel: string | null;
  createOpen: boolean;
  createError: string | null;
  projectName: string;
  projectVenue: ProjectVenue;
  onOpenCreate: () => void;
  onCloseCreate: () => void;
  setProjectName: (value: string) => void;
  setProjectVenue: (value: ProjectVenue) => void;
  onCreate: () => void;
  onOpen: () => void;
  onImportZip: () => void;
  onJoinCollab: () => void;
  onOpenTutorial: () => void;
  onSettings: () => void;
  onInstallTex: () => void;
  onOpenOverleaf?: () => void;
}) {
  return (
    <div className="welcome-screen">
      <div className="welcome-titlebar" onMouseDown={beginWindowDrag} onDoubleClick={toggleWindowFullscreen}>
        <button className="icon-button" onClick={props.onSettings} title="Settings"><Settings size={16} /></button>
      </div>
      <div className="welcome-glow" />
      <div className="welcome-content">
        <div className="brand-mark"><Sparkles size={24} /></div>
        <p className="eyebrow">LATTICE</p>
        <h1>Research, written with evidence.</h1>
        <p className="welcome-copy">
          A local-first LaTeX workspace where your writing agent, sources, manuscript, and rendered paper stay connected.
        </p>
        <div className="welcome-actions">
          <MotionButton
            className={buttonClassName({ variant: "primary", size: "form" })}
            magnetic
            onClick={props.onOpenCreate}
          >
            <Plus size={17} /> New project
          </MotionButton>
          <MotionButton
            className={buttonClassName({ variant: "secondary", size: "form" })}
            onClick={props.onOpen}
          >
            <MorphIcon size={17} idle={<Folder size={17} />} hover={<FolderOpen size={17} />} />
            Open folder
          </MotionButton>
          <MotionButton
            className={buttonClassName({ variant: "ghost", size: "form" })}
            disabled={Boolean(props.busyLabel)}
            onClick={props.onOpenTutorial}
          >
            <Sparkles size={17} /> Guided tutorial
          </MotionButton>
        </div>
        <div className="welcome-more">
          {props.onOpenOverleaf && (
            <button className="welcome-more-action" onClick={props.onOpenOverleaf}>
              <Cloud size={15} /> Open from Overleaf
            </button>
          )}
          <button className="welcome-more-action" onClick={props.onImportZip}>
            <FileArchive size={15} /> Import ZIP
          </button>
          <button className="welcome-more-action" onClick={props.onJoinCollab}>
            <Radio size={15} /> Join share
          </button>
        </div>
        <Button size="compact" variant="ghost" className="welcome-tex-setup" onClick={props.onInstallTex}>
          Install LaTeX tools (needed to compile PDFs)
        </Button>
        {props.busyLabel && <p className="busy-label"><InfinityLoader size={15} /> {props.busyLabel}</p>}
      </div>
      {props.createOpen && (
        <CreateProjectDialog
          projectName={props.projectName}
          setProjectName={props.setProjectName}
          projectVenue={props.projectVenue}
          setProjectVenue={props.setProjectVenue}
          error={props.createError}
          onCreate={props.onCreate}
          onClose={props.onCloseCreate}
        />
      )}
    </div>
  );
}

const PROJECT_VENUES: { id: ProjectVenue; label: string; detail: string }[] = [
  { id: "neurips", label: "NeurIPS", detail: "Official 2026 style, preprint option" },
  { id: "icml", label: "ICML", detail: "Official 2026 style, preprint option" },
  { id: "iclr", label: "ICLR", detail: "Official 2026 conference style" },
];

export function CreateProjectDialog(props: {
  projectName: string;
  setProjectName: (value: string) => void;
  projectVenue: ProjectVenue;
  setProjectVenue: (value: ProjectVenue) => void;
  error: string | null;
  onCreate: () => void;
  onClose: () => void;
}) {
  const venue = PROJECT_VENUES.find((item) => item.id === props.projectVenue) ?? PROJECT_VENUES[0];
  return (
    <ModalDialog label="Create a research project" onClose={props.onClose}>
      <div className="modal create-project-modal">
        <div className="modal-icon"><FileText size={20} /></div>
        <h2>Create a research project</h2>
        <p>
          Creates a {venue.label} preprint template with bibliography and project brief.
        </p>
        <label>
          Project name
          <Input controlSize="form" autoFocus value={props.projectName} onChange={(event) => props.setProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onCreate()} />
        </label>
        <fieldset className="venue-picker" aria-label="Venue template">
          <legend>Venue template</legend>
          {PROJECT_VENUES.map((item) => (
            <label key={item.id} className={`venue-option ${props.projectVenue === item.id ? "active" : ""}`}>
              <input
                type="radio"
                name="project-venue"
                value={item.id}
                checked={props.projectVenue === item.id}
                onChange={() => props.setProjectVenue(item.id)}
              />
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <MotionButton className={buttonClassName({ variant: "primary" })} onClick={props.onCreate}>Choose location</MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}

export function RenameDialog(props: {
  target: RenameTarget;
  error: string | null;
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const initialName = props.target.kind === "label"
    ? props.target.label
    : props.target.kind === "environment"
      ? props.target.name
      : props.target.kind === "wrap-environment"
        ? "equation"
        : props.target.key;
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const title = props.target.kind === "label"
      ? "Rename label"
      : props.target.kind === "citation"
        ? "Rename citation key"
        : props.target.kind === "environment"
          ? "Rename environment"
          : "Wrap in environment";
  const copy = props.target.kind === "label"
      ? "Updates every \\label and \\ref/\\cref occurrence across the project."
      : props.target.kind === "citation"
        ? "Updates the bibliography entry and every \\cite occurrence across the project."
        : props.target.kind === "environment"
          ? "Renames the matching \\begin and \\end pair under the cursor."
          : "Wraps the current selection (or empty cursor) in \\begin{…}/\\end{…}.";
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    await props.onRename(name.trim());
    setBusy(false);
  };
  return (
    <ModalDialog label={title} onClose={props.onClose} closeDisabled={busy}>
      <div className="modal rename-modal">
        <div className="modal-icon"><Pencil size={19} /></div>
        <h2>{title}</h2>
        <p>{copy}</p>
        <label>
          Name
          <Input
            controlSize="form"
            autoFocus
            aria-label="New name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>Cancel</Button>
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Renaming…" : "Rename"}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}

export function ProjectMenu(props: {
  currentPath: string;
  recentProjects: RecentProject[];
  busyLabel: string | null;
  onRecent: (path: string) => void;
  onOpen: () => void;
  onNew: () => void;
  onOpenTutorial: () => void;
  onExportZip: () => void;
  onOpenOverleaf?: () => void;
  onSettings: () => void;
}) {
  const alternatives = props.recentProjects.filter((item) => item.path !== props.currentPath);
  const busy = Boolean(props.busyLabel);
  return (
    <DropdownMenuContent align="start" sideOffset={6} className="w-52">
      <DropdownMenuLabel>Recent projects</DropdownMenuLabel>
      {alternatives.map((item) => (
        <DropdownMenuItem key={item.path} title={item.path} disabled={busy} onSelect={() => props.onRecent(item.path)}>
          <Folder />
          <span className="truncate font-medium">{item.name}</span>
        </DropdownMenuItem>
      ))}
      {!alternatives.length && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">No other recent projects yet.</p>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={props.onOpen}>
        <FolderOpen /> Open another folder
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onNew}><Plus /> New project</DropdownMenuItem>
      {props.onOpenOverleaf && (
        <DropdownMenuItem disabled={busy} onSelect={props.onOpenOverleaf}>
          <Cloud /> Open from Overleaf
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={props.onExportZip}><FileArchive /> Export ZIP</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={busy} onSelect={props.onOpenTutorial}>
        <Sparkles /> Guided tutorial
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onSettings}><Settings /> Settings</DropdownMenuItem>
      {props.busyLabel && (
        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <InfinityLoader size={12} /> {props.busyLabel}
        </p>
      )}
    </DropdownMenuContent>
  );
}
