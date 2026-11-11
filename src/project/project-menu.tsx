/**
 * The project title's menu: the recent projects and a folder, each opened in
 * a window of its own or (its trailing item) in this one, then the project's
 * other actions. Loaded as the menu is first wanted, so the title bar's
 * startup carries only its button (app-titlebar.tsx).
 */
import { useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { AppWindowMac, Cloud, FileArchive, Folder, FolderOpen, GitBranch, PackageCheck, Plus, Settings, Sparkles } from "lucide-react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "../components/ui/dropdown-menu";
import type { RecentProject } from "../settings/app-settings";
import { switcherProjects } from "./first-pages";

/**
 * A menu row's own action, opening it in this window: the row itself opens a
 * window of its own, the default once a project is open. A menu item of its
 * own beside the row, so the keyboard reaches it as the next item down.
 */
function InThisWindow({ label, disabled, onSelect }: { label: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem className="shrink-0" aria-label={label} title={label} disabled={disabled} onSelect={onSelect}>
      <AppWindowMac />
    </DropdownMenuItem>
  );
}

export function ProjectMenu(props: {
  currentPath: string;
  recentProjects: RecentProject[];
  busyLabel: string | null;
  /** Open a recent project in a window of its own, or with `inThisWindow` in this one. */
  onRecent: (path: string, inThisWindow?: boolean) => void;
  onOpen: (inThisWindow?: boolean) => void;
  onNew: () => void;
  onClone: () => void;
  onOpenTutorial: () => void;
  onExportZip: () => void;
  onExportArxiv: () => void;
  onOpenOverleaf?: () => void;
  onSettings: () => void;
}) {
  const { t } = useLingui();
  const alternatives = switcherProjects(props.recentProjects, props.currentPath);
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
      {/* With no other project to go back to, the menu starts at its actions. */}
      {alternatives.length > 0 && (
        <>
          <DropdownMenuLabel>{t`Recent projects`}</DropdownMenuLabel>
          {alternatives.map(({ path, name }) => (
            <div key={path} className="flex">
              <DropdownMenuItem className="min-w-0 flex-1" title={path} disabled={busy} onSelect={() => props.onRecent(path)}>
                <Folder />
                <span className="truncate font-medium">{name}</span>
              </DropdownMenuItem>
              <InThisWindow label={t`Open ${name} in this window`} disabled={busy} onSelect={() => props.onRecent(path, true)} />
            </div>
          ))}
          <DropdownMenuSeparator />
        </>
      )}
      <div className="flex">
        <DropdownMenuItem className="min-w-0 flex-1" onSelect={() => props.onOpen()}>
          <FolderOpen /> {t`Open another folder`}
        </DropdownMenuItem>
        <InThisWindow label={t`Open a folder in this window`} onSelect={() => props.onOpen(true)} />
      </div>
      <DropdownMenuItem onSelect={props.onNew}><Plus /> {t`New project`}</DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onClone}><GitBranch /> {t`Clone repository…`}</DropdownMenuItem>
      {props.onOpenOverleaf && (
        <DropdownMenuItem disabled={busy} onSelect={props.onOpenOverleaf}>
          <Cloud /> {t`Open from Overleaf`}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={props.onExportZip}><FileArchive /> {t`Export ZIP`}</DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onExportArxiv}><PackageCheck /> {t`Export for arXiv…`}</DropdownMenuItem>
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
