import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
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
import { MorphIcon, MotionButton } from "../components/ui/motion";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { Input } from "../components/ui/input";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import { type ProjectVenue, type RenameTarget } from "../app-types";
import { type RecentProject } from "../settings/app-settings";
import { beginWindowDrag, toggleWindowFullscreen } from "../app-utils";
import { ModalDialog } from "../components/ui/modal-dialog";

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
  const { t } = useLingui();
  return (
    <div className="welcome-screen">
      <div className="welcome-titlebar" onMouseDown={beginWindowDrag} onDoubleClick={toggleWindowFullscreen}>
        <button className="icon-button" onClick={props.onSettings} title={t`Settings`}><Settings size={16} /></button>
      </div>
      <div className="welcome-glow" />
      <div className="welcome-content">
        <div className="brand-mark"><Sparkles size={24} /></div>
        <p className="eyebrow">LATTICE</p>
        <h1>{t`Research, written with evidence`}</h1>
        <p className="welcome-copy">
          {t`A local-first LaTeX workspace where your writing agent, sources, manuscript, and rendered paper stay connected`}
        </p>
        <div className="welcome-actions">
          <MotionButton
            className={buttonClassName({ variant: "primary", size: "form" })}
            magnetic
            onClick={props.onOpenCreate}
          >
            <Plus size={17} /> {t`New project`}
          </MotionButton>
          <MotionButton
            className={buttonClassName({ variant: "secondary", size: "form" })}
            onClick={props.onOpen}
          >
            <MorphIcon size={17} idle={<Folder size={17} />} hover={<FolderOpen size={17} />} />
            {t`Open folder`}
          </MotionButton>
          <MotionButton
            className={buttonClassName({ variant: "ghost", size: "form" })}
            disabled={Boolean(props.busyLabel)}
            onClick={props.onOpenTutorial}
          >
            <Sparkles size={17} /> {t`Guided tutorial`}
          </MotionButton>
        </div>
        <div className="welcome-more">
          {props.onOpenOverleaf && (
            <button className="welcome-more-action" onClick={props.onOpenOverleaf}>
              <Cloud size={15} /> {t`Open from Overleaf`}
            </button>
          )}
          <button className="welcome-more-action" onClick={props.onImportZip}>
            <FileArchive size={15} /> {t`Import ZIP`}
          </button>
          <button className="welcome-more-action" onClick={props.onJoinCollab}>
            <Radio size={15} /> {t`Join share`}
          </button>
        </div>
        <Button size="compact" variant="ghost" className="welcome-tex-setup" onClick={props.onInstallTex}>
          {t`Install LaTeX tools (needed to compile PDFs)`}
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

const PROJECT_VENUES: { id: ProjectVenue; label: string }[] = [
  { id: "neurips", label: "NeurIPS" },
  { id: "icml", label: "ICML" },
  { id: "iclr", label: "ICLR" },
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
  const { t } = useLingui();
  const venue = PROJECT_VENUES.find((item) => item.id === props.projectVenue) ?? PROJECT_VENUES[0];
  return (
    <ModalDialog label={t`Create a research project`} onClose={props.onClose}>
      <div className="modal create-project-modal">
        <div className="modal-icon"><FileText size={20} /></div>
        <h2>{t`Create a research project`}</h2>
        <p>
          {t`Creates a ${venue.label} preprint template with bibliography and project brief`}
        </p>
        <label>
          {t`Project name`}
          <Input controlSize="form" autoFocus value={props.projectName} onChange={(event) => props.setProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onCreate()} />
        </label>
        <fieldset className="venue-picker" aria-label={t`Venue template`}>
          <legend>{t`Venue template`}</legend>
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
                <small>{item.id === "iclr"
                  ? t`Official 2026 conference style`
                  : t`Official 2026 style, preprint option`}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
          <MotionButton className={buttonClassName({ variant: "primary" })} onClick={props.onCreate}>{t`Choose location`}</MotionButton>
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
  const { t } = useLingui();
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
      ? t`Rename label`
      : props.target.kind === "citation"
        ? t`Rename citation key`
        : props.target.kind === "environment"
          ? t`Rename environment`
          : t`Wrap in environment`;
  const copy = props.target.kind === "label"
      ? t`Updates every \\label and \\ref/\\cref occurrence across the project`
      : props.target.kind === "citation"
        ? t`Updates the bibliography entry and every \\cite occurrence across the project`
        : props.target.kind === "environment"
          ? t`Renames the matching \\begin and \\end pair under the cursor`
          : t`Wraps the current selection (or empty cursor) in \\begin{…}/\\end{…}`;
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
          {t`Name`}
          <Input
            controlSize="form"
            autoFocus
            aria-label={t`New name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t`Cancel`}</Button>
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            {busy ? t`Renaming…` : t`Rename`}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}

/** How many other recent projects the switcher offers before it stops. */
const MAX_RECENT_PROJECT_ITEMS = 5;

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
  const { t } = useLingui();
  // The stored list runs deeper (share recovery resolves a prior root against
  // it), but a switcher is for the few projects you move between — past five
  // the menu turns into a scroll and "Open another folder" is the better path.
  const alternatives = props.recentProjects
    .filter((item) => item.path !== props.currentPath)
    .slice(0, MAX_RECENT_PROJECT_ITEMS);
  const busy = Boolean(props.busyLabel);
  return (
    <DropdownMenuContent align="center" sideOffset={6} className="w-52">
      <DropdownMenuLabel>{t`Recent projects`}</DropdownMenuLabel>
      {alternatives.map((item) => (
        <DropdownMenuItem key={item.path} title={item.path} disabled={busy} onSelect={() => props.onRecent(item.path)}>
          <Folder />
          <span className="truncate font-medium">{item.name}</span>
        </DropdownMenuItem>
      ))}
      {!alternatives.length && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t`No other recent projects yet`}</p>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={props.onOpen}>
        <FolderOpen /> {t`Open another folder`}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onNew}><Plus /> {t`New project`}</DropdownMenuItem>
      {props.onOpenOverleaf && (
        <DropdownMenuItem disabled={busy} onSelect={props.onOpenOverleaf}>
          <Cloud /> {t`Open from Overleaf`}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={props.onExportZip}><FileArchive /> {t`Export ZIP`}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={busy} onSelect={props.onOpenTutorial}>
        <Sparkles /> {t`Guided tutorial`}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onSettings}><Settings /> {t`Settings`}</DropdownMenuItem>
      {props.busyLabel && (
        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <InfinityLoader size={12} /> {props.busyLabel}
        </p>
      )}
    </DropdownMenuContent>
  );
}
