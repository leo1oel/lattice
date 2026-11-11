/**
 * The title bar's project tabs, "Projects in this window" (window-projects.ts),
 * shown once a window has held two projects. The active project's tab is the
 * project menu's button, as the lone project title is; another's switches to
 * it, asking first when the project left has work running (leave-project.ts).
 * ⌃Tab and ⌃⇧Tab go round them (the command table): ⌘1 to ⌘9 and the + beside
 * the layout switch belong to the layout workspaces.
 *
 * Each tab closes from its × and moves to a window of its own from its context
 * menu (or Shift+F10). Closing or moving the active project switches to its
 * neighbour first; the last project left folds the tabs back into the title.
 * Loaded with the second project.
 */
import { useReducer, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { SquareArrowOutUpRight, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { windowProjects, type WindowProject } from "./window-projects";
import type { useProjectLifecycle } from "./use-project-lifecycle";
import "./project-tabs.css";

export type ProjectTabActions = Pick<ReturnType<typeof useProjectLifecycle>, "openInThisWindow" | "openProjectWindow">;

/** Switch away from `root` to its right-hand neighbour (else its left), when it is the one shown. True when it no longer is. */
async function leave(root: string, active: string, actions: ProjectTabActions) {
  if (root !== active) return true;
  const list = windowProjects.get();
  const index = list.findIndex((entry) => entry.root === root);
  const next = list[index + 1] ?? list[index - 1];
  return Boolean(next) && await actions.openInThisWindow(next.root);
}

/** Take `root` out of this window. Suspended, it has nothing to save: its edits were saved as it was left. */
async function closeWindowProject(root: string, active: string, actions: ProjectTabActions) {
  if (await leave(root, active, actions)) windowProjects.remove(root);
}

/** Give `root` a window of its own; it leaves this one's tabs once that window is open. */
async function moveWindowProject(root: string, active: string, actions: ProjectTabActions) {
  if (await leave(root, active, actions) && await actions.openProjectWindow(root) === null) windowProjects.remove(root);
}

type MenuAt = { entry: WindowProject; x: number; y: number } | null;
const replaceMenu = (_: MenuAt, next: MenuAt) => next;

export default function ProjectTabs({ projects, active, activeTab, actions, disabled }: {
  projects: readonly WindowProject[];
  active: string;
  /** The project menu's button, standing for the active project. */
  activeTab: ReactNode;
  actions: ProjectTabActions;
  /** A switch is under way. */
  disabled: boolean;
}) {
  const { t } = useLingui();
  // The project a right-click (or Shift+F10) landed on, and where its menu opens.
  const [menuAt, setMenuAt] = useReducer(replaceMenu, null);
  const openMenuAt = (tab: HTMLElement, at?: { x: number; y: number }) => {
    const entry = projects.find((item) => item.root === tab.dataset.projectRoot);
    if (!entry) return false;
    const box = tab.getBoundingClientRect();
    setMenuAt({ entry, x: at?.x ?? box.left, y: at?.y ?? box.bottom });
    return true;
  };
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-project-root]");
    if (tab && openMenuAt(tab, { x: event.clientX, y: event.clientY })) event.preventDefault();
  };
  // macOS has no context-menu key: Shift+F10 opens a tab's menu, as on the layout switch.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-project-root]");
    if (event.key === "F10" && event.shiftKey && tab && openMenuAt(tab)) event.preventDefault();
  };
  return (
    <div role="group" aria-label={t`Projects in this window`} className="project-tabs" onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
      {projects.map((entry) => {
        const { name } = entry;
        const current = entry.root === active;
        return (
          <div key={entry.root} className="project-tab" data-project-root={entry.root} data-active={current || undefined}>
            {current ? activeTab : (
              <button
                type="button"
                className="project-tab-name"
                title={entry.root}
                disabled={disabled}
                onClick={() => void actions.openInThisWindow(entry.root)}
              >
                {name}
              </button>
            )}
            <button
              type="button"
              className="project-tab-close"
              aria-label={t`Close ${name}`}
              title={t`Close ${name}`}
              disabled={disabled}
              onClick={() => void closeWindowProject(entry.root, active, actions)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {menuAt && (
        <DropdownMenu open modal={false} onOpenChange={(open) => { if (!open) setMenuAt(null); }}>
          {createPortal(
            <DropdownMenuTrigger asChild>
              <span aria-hidden="true" className="project-tab-menu-anchor" style={{ left: menuAt.x, top: menuAt.y }} />
            </DropdownMenuTrigger>,
            document.body,
          )}
          <DropdownMenuContent align="start" sideOffset={2} className="min-w-[11rem]">
            <DropdownMenuItem disabled={disabled} onSelect={() => void moveWindowProject(menuAt.entry.root, active, actions)}>
              <SquareArrowOutUpRight size={14} />{t`Open in New Window`}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled} onSelect={() => void closeWindowProject(menuAt.entry.root, active, actions)}>
              <X size={14} />{t`Close`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
