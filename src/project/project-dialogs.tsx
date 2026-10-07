import { useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Cloud, FileArchive, FileText, Folder, FolderOpen, Pencil, Plus, Settings, Sparkles, Wrench } from "lucide-react";
import { MorphIcon, MotionButton } from "../components/ui/motion";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "../components/ui/dropdown-menu";
import type { ProjectVenue, RenameTarget } from "../app-types";
import type { RecentProject } from "../settings/app-settings";
import { beginWindowDrag, toggleWindowFullscreen } from "../app-utils";
import { ModalDialog } from "../components/ui/modal-dialog";
import { LatticeMark } from "../components/ui/lattice-mark";
import { WelcomeLattice } from "./welcome-lattice";

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
      <WelcomeLattice />
      <div className="welcome-content">
        <div className="brand-mark"><LatticeMark size={34} motion="weave" /></div>
        <p className="eyebrow">LATTICE</p>
        <h1>{t`Research, written with evidence`}</h1>
        <div className="welcome-actions">
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            magnetic
            onClick={props.onOpenCreate}
          >
            <Plus size={17} /> {t`New project`}
          </MotionButton>
          <MotionButton
            className={buttonClassName({ variant: "secondary" })}
            onClick={props.onOpen}
          >
            <MorphIcon size={17} idle={<Folder size={17} />} hover={<FolderOpen size={17} />} />
            {t`Open folder`}
          </MotionButton>
          <MotionButton
            className={buttonClassName({ variant: "ghost" })}
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
          <button className="welcome-more-action" onClick={props.onInstallTex}>
            <Wrench size={15} /> {t`Install LaTeX tools`}
          </button>
        </div>
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
        <label>
          {t`Project name`}
          <Input autoFocus value={props.projectName} onChange={(event) => props.setProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onCreate()} />
        </label>
        <div className="venue-picker">
          <span className="venue-picker-label">{t`Venue template`}</span>
          <Select
            value={props.projectVenue}
            onValueChange={(value) => props.setProjectVenue(value as ProjectVenue)}
          >
            <SelectTrigger aria-label={t`Venue template`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="venue-picker-content" position="popper" align="start">
              {PROJECT_VENUES.map((item) => (
                <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <small className="venue-picker-detail">
            {venue.id === "iclr"
              ? t`Official 2026 style`
              : t`Official 2026 style · preprint draft`}
          </small>
        </div>
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
  const target = props.target;
  const [name, setName] = useState(() => (
    target.kind === "label" ? target.label
      : target.kind === "citation" ? target.key
        : target.kind === "environment" ? target.name
          : "equation"
  ));
  const [busy, setBusy] = useState(false);
  const [title, copy] = {
    label: [t`Rename label`, t`Updates every \\ref to it`],
    citation: [t`Rename citation key`, t`Updates the .bib entry and every \\cite`],
    environment: [t`Rename environment`, t`The \\begin and \\end under the cursor`],
    "wrap-environment": [t`Wrap in environment`, t`Wraps the selection in \\begin…\\end`],
  }[target.kind];
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
  // Settings opens as a transition and puts focus in its search field, which
  // can land before the closing menu returns focus to its trigger.
  const handsOffFocusRef = useRef(false);
  return (
    <DropdownMenuContent
      align="center"
      sideOffset={6}
      className="w-52"
      onCloseAutoFocus={(event) => {
        if (!handsOffFocusRef.current) return;
        handsOffFocusRef.current = false;
        event.preventDefault();
      }}
    >
      <DropdownMenuLabel>{t`Recent projects`}</DropdownMenuLabel>
      {alternatives.map((item) => (
        <DropdownMenuItem key={item.path} title={item.path} disabled={busy} onSelect={() => props.onRecent(item.path)}>
          <Folder />
          <span className="truncate font-medium">{item.name}</span>
        </DropdownMenuItem>
      ))}
      {!alternatives.length && (
        <p className="px-2 py-1.5 text-[length:var(--type-body-compact-size)] leading-[var(--type-body-compact-line-height)] text-muted-foreground">{t`No other recent projects yet`}</p>
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
      <DropdownMenuItem
        onSelect={() => {
          handsOffFocusRef.current = true;
          props.onSettings();
        }}
      >
        <Settings /> {t`Settings`}
      </DropdownMenuItem>
      {props.busyLabel && (
        <p className="flex items-center gap-2 px-2 py-1.5 text-[length:var(--type-body-compact-size)] leading-[var(--type-body-compact-line-height)] text-muted-foreground">
          <InfinityLoader size={12} /> {props.busyLabel}
        </p>
      )}
    </DropdownMenuContent>
  );
}
