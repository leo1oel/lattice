/**
 * The window title bar: the project switcher over the left column, then the
 * panel controls and the project-wide tools (comments, Overleaf, Git,
 * history). A document's own actions (Build, Edit / Split /
 * Preview) live in its panel's header instead.
 *
 * In focus mode the bar keeps only the window's own controls and `focusBar`
 * (the document's name and the way out): nothing else of the chrome.
 *
 * The canvas toolbar arrives as an element rather than as props. It reads about
 * fifty of App's values — collaboration presence, Overleaf channel state, the
 * dirty flag of the active document — and none of the rest of the title bar
 * needs any of them, so pulling them through here would double the interface
 * for a component that only ever gets slotted into one place.
 */
import { type ComponentProps, type Dispatch, type ReactNode, type SetStateAction, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { ProjectMenu } from "../project/project-dialogs";
import { beginWindowDrag, titleBarDoubleClick } from "../app-utils";
import type { ProjectSnapshot } from "../app-types";
import type { OpenDocuments } from "./use-open-documents";
import { useWindowTitle } from "./use-native-window";

export function AppTitlebar({ project, documents, projectMenu, panelControls, canvasToolbar, focusBar }: {
  project: ProjectSnapshot;
  /** The file or Paper in front, whose name the window's title and the focus bar carry. */
  documents: Pick<OpenDocuments, "paper" | "activeTab">;
  /** The project switcher's menu, plus whether it is open and what may disable it. */
  projectMenu: Omit<ComponentProps<typeof ProjectMenu>, "currentPath" | "onSettings"> & {
    /** Settings, opened from the menu, returns focus to `returnFocus`: the menu's trigger. */
    onSettings: (returnFocus: HTMLElement | null) => void;
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    importing: boolean;
    building: boolean;
  };
  /** The Panels menu, the layout switch, search and the hidden-panel chips. */
  panelControls: ReactNode;
  canvasToolbar: ReactNode;
  /** Focus mode's bar, given the front document's name, which stands in for everything after the traffic lights. */
  focusBar?: (documentTitle: string) => ReactNode;
}) {
  const { t } = useLingui();
  const { open: menuOpen, setOpen: setMenuOpen, importing, building, onSettings, ...menu } = projectMenu;
  // The menu item that opens Settings closes with the menu, so Settings is
  // handed the trigger to return focus to instead.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const projectName = project.manifest.name;
  const documentTitle = documents.paper?.title ?? documents.activeTab.split("/").pop() ?? "";
  // Project first: where the system shortens a title, the project is what tells windows apart.
  useWindowTitle(documentTitle ? t`${projectName} — ${documentTitle}` : projectName);
  if (focusBar) {
    return (
      <header className="titlebar titlebar-focus" onMouseDown={beginWindowDrag} onDoubleClick={titleBarDoubleClick}>
        <div className="traffic-space" />
        {focusBar(documentTitle)}
      </header>
    );
  }
  return (
    <header className="titlebar" onMouseDown={beginWindowDrag} onDoubleClick={titleBarDoubleClick}>
      <div className="titlebar-sidebar">
        <div className="titlebar-navigator">
          <div className="traffic-space" />
        </div>
        <div className="project-switcher">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                className="project-title"
                aria-label={t`Switch project`}
                disabled={building || importing}
              >
                <span>{projectName}</span>
                <ChevronDown size={12} />
              </button>
            </DropdownMenuTrigger>
            <ProjectMenu currentPath={project.root} {...menu} onSettings={() => onSettings(triggerRef.current)} />
          </DropdownMenu>
          <div className="titlebar-drag-area" aria-hidden="true" />
        </div>
      </div>
      <div className="titlebar-main">
        {panelControls}
        {canvasToolbar}
      </div>
    </header>
  );
}
