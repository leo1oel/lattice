import { useState } from "react";
import {
  FileArchive,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Plus,
  Radio,
  Settings,
  Sparkles,
} from "lucide-react";
import { MotionButton } from "./motion";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "./components/ui/dropdown-menu";
import { type ProjectVenue, type RenameTarget } from "./app-types";
import { type RecentProject } from "./app-settings";
import { beginWindowDrag, toggleWindowFullscreen } from "./app-utils";

export function Welcome(props: {
  busyLabel: string | null;
  createOpen: boolean;
  error: string | null;
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
  onSettings: () => void;
  onInstallTex: () => void;
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
          <MotionButton className="primary-button" magnetic onClick={props.onOpenCreate}>
            <Plus size={17} /> New project
          </MotionButton>
          <button className="secondary-button" onClick={props.onOpen}>
            <FolderOpen size={17} /> Open folder
          </button>
          <button className="secondary-button" onClick={props.onImportZip}>
            <FileArchive size={17} /> Import ZIP
          </button>
          <button className="secondary-button" onClick={props.onJoinCollab}>
            <Radio size={17} /> Join share
          </button>
        </div>
        <button type="button" className="text-button welcome-tex-setup" onClick={props.onInstallTex}>
          Install LaTeX tools (needed to compile PDFs)
        </button>
        {props.busyLabel && <p className="busy-label"><LoaderCircle className="spin" size={15} /> {props.busyLabel}</p>}
        {props.error && <p className="welcome-error">{props.error}</p>}
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
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal create-project-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><FileText size={20} /></div>
        <h2>Create a research project</h2>
        <p>
          Lattice will create a {venue.label} preprint template, bibliography, project brief, and private conversation history.
        </p>
        <label>
          Project name
          <input autoFocus value={props.projectName} onChange={(event) => props.setProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onCreate()} />
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
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <MotionButton className="primary-button" onClick={props.onCreate}>Choose location</MotionButton>
        </div>
      </div>
    </div>
  );
}

export function RenameDialog(props: {
  target: RenameTarget;
  error: string | null;
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const initialName = props.target.kind === "entry"
    ? props.target.name
    : props.target.kind === "paper"
      ? props.target.paper.title
      : props.target.kind === "label"
        ? props.target.label
        : props.target.kind === "environment"
          ? props.target.name
          : props.target.kind === "wrap-environment"
            ? "equation"
            : props.target.key;
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const title = props.target.kind === "paper"
    ? "Rename paper"
    : props.target.kind === "label"
      ? "Rename label"
      : props.target.kind === "citation"
        ? "Rename citation key"
        : props.target.kind === "environment"
          ? "Rename environment"
          : props.target.kind === "wrap-environment"
            ? "Wrap in environment"
            : "Rename project item";
  const copy = props.target.kind === "paper"
    ? "This changes the title shown in Papers. The citation key stays unchanged."
    : props.target.kind === "label"
      ? "Updates every \\label and \\ref/\\cref occurrence across the project."
      : props.target.kind === "citation"
        ? "Updates the bibliography entry and every \\cite occurrence across the project."
        : props.target.kind === "environment"
          ? "Renames the matching \\begin and \\end pair under the cursor."
          : props.target.kind === "wrap-environment"
            ? "Wraps the current selection (or empty cursor) in \\begin{…}/\\end{…}."
            : "Use a simple name. Existing file extensions are kept when omitted.";
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    await props.onRename(name.trim());
    setBusy(false);
  };
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal rename-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><Pencil size={19} /></div>
        <h2>{title}</h2>
        <p>{copy}</p>
        <label>
          Name
          <input
            autoFocus
            aria-label="New name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") props.onClose();
            }}
          />
        </label>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <MotionButton className="primary-button" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? "Renaming…" : "Rename"}</MotionButton>
        </div>
      </div>
    </div>
  );
}

export function ProjectMenu(props: {
  currentPath: string;
  recentProjects: RecentProject[];
  busyLabel: string | null;
  onRecent: (path: string) => void;
  onOpen: () => void;
  onNew: () => void;
  onExportZip: () => void;
}) {
  const alternatives = props.recentProjects.filter((item) => item.path !== props.currentPath);
  const busy = Boolean(props.busyLabel);
  return (
    <DropdownMenuContent align="start" sideOffset={6} className="w-72">
      <DropdownMenuLabel>Recent projects</DropdownMenuLabel>
      {alternatives.map((item) => (
        <DropdownMenuItem key={item.path} disabled={busy} onSelect={() => props.onRecent(item.path)}>
          <Folder />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{item.name}</span>
            <span className="truncate text-xs text-muted-foreground">{item.path}</span>
          </span>
        </DropdownMenuItem>
      ))}
      {!alternatives.length && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">No other recent projects yet.</p>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={props.onOpen}>
        <FolderOpen /> Open another folder <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onNew}><Plus /> New project</DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onExportZip}><FileArchive /> Export ZIP</DropdownMenuItem>
      {props.busyLabel && (
        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" /> {props.busyLabel}
        </p>
      )}
    </DropdownMenuContent>
  );
}
