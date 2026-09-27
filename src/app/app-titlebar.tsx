/**
 * The window title bar: the sidebar toggle and project switcher over the
 * sidebar's column, then the editor tab strip, the canvas toolbar and the build
 * button over the canvas.
 *
 * The canvas toolbar arrives as an element rather than as props. It reads about
 * fifty of App's values — collaboration presence, Overleaf channel state, the
 * dirty flags of both panes — and none of the rest of the title bar needs any
 * of them, so pulling them through here would double the interface for a
 * component that only ever gets slotted into one place.
 */
import { type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Check,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Square,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import { StateSwap } from "../components/ui/motion";
import { DropdownMenu, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { EditorTabs, type EditorDropZone, type EditorTab } from "../canvas/editor-tabs";
import { ProjectMenu } from "../project/project-dialogs";
import { beginWindowDrag, toggleWindowFullscreen } from "../app-utils";
import type { BuildPreferences, RecentProject } from "../settings/app-settings";
import type { BuildResult, CanvasMode, CompileProject, ProjectSnapshot, SettingsTab } from "../app-types";

export type AppTitlebarProps = {
  abortBuild: () => Promise<void>;
  activeTabKey: string;
  build: BuildResult | null;
  building: boolean;
  buildPreferences: BuildPreferences;
  busyLabel: string | null;
  canvasMode: CanvasMode;
  canvasToolbar: ReactNode;
  chooseExisting: () => Promise<void>;
  chooseRecentProject: (path: string) => Promise<void>;
  cleanAndRebuild: () => Promise<void>;
  cleaning: boolean;
  compile: CompileProject;
  dropProjectPath: (path: string, zone: EditorDropZone, options?: { preserveSplitRatio?: boolean; preservePreview?: boolean; }) => Promise<true | undefined>;
  editorTabItems: EditorTab[];
  exportProjectZip: () => Promise<void>;
  importing: boolean;
  openSettings: (tab?: SettingsTab) => void;
  openTutorialProject: () => Promise<boolean>;
  project: ProjectSnapshot;
  projectMenuOpen: boolean;
  recentProjects: RecentProject[];
  requestCloseEditorTab: (path: string) => void;
  setEditorTabPinned: (path: string, pinned: boolean) => void;
  selectEditorTab: (path: string) => void;
  setCreateError: Dispatch<SetStateAction<string | null>>;
  setCreateOpen: Dispatch<SetStateAction<boolean>>;
  setOpenTabs: Dispatch<SetStateAction<string[]>>;
  setOverleafPickerOpen: Dispatch<SetStateAction<boolean>>;
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  sidebarOpen: boolean;
  sidebarResizing: boolean;
  sidebarWidth: number;
};

export function AppTitlebar(props: AppTitlebarProps) {
  const { t } = useLingui();
  const { build, building, project, sidebarOpen } = props;
  return (
    <header className="titlebar" onMouseDown={beginWindowDrag} onDoubleClick={toggleWindowFullscreen}>
      <div className={`titlebar-sidebar ${sidebarOpen ? "" : "collapsed"}`} style={{ width: sidebarOpen ? props.sidebarWidth + 1 : undefined }}>
        <div className="titlebar-navigator">
          <div className="traffic-space" />
          <div className="titlebar-sidebar-toggle">
            <Tip label={sidebarOpen ? t`Hide sidebar` : t`Show sidebar`}>
              <button className="icon-button" onClick={() => props.setSidebarOpen((value) => !value)}>
                <span key={sidebarOpen ? "open" : "closed"} className="toggle-icon">
                  {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                </span>
              </button>
            </Tip>
          </div>
        </div>
        <div className="project-switcher">
          <DropdownMenu open={props.projectMenuOpen} onOpenChange={props.setProjectMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                className="project-title"
                aria-label={t`Switch project`}
                disabled={building || props.importing}
              >
                <span>{project.manifest.name}</span>
                <ChevronDown size={13} />
              </button>
            </DropdownMenuTrigger>
            <ProjectMenu
              currentPath={project.root}
              recentProjects={props.recentProjects}
              busyLabel={props.busyLabel}
              onRecent={props.chooseRecentProject}
              onOpen={() => void props.chooseExisting()}
              onNew={() => {
                props.setCreateError(null);
                props.setCreateOpen(true);
              }}
              onOpenOverleaf={() => props.setOverleafPickerOpen(true)}
              onOpenTutorial={() => void props.openTutorialProject()}
              onExportZip={() => void props.exportProjectZip()}
              onSettings={() => props.openSettings("appearance")}
            />
          </DropdownMenu>
          <div className="titlebar-drag-area" aria-hidden="true" />
        </div>
      </div>
      <div className="titlebar-main">
        <EditorTabs
          tabs={props.editorTabItems}
          activePath={props.activeTabKey}
          animateLayout={!props.sidebarResizing}
          canCloseLast={props.canvasMode === "pdf"}
          onDropTab={props.dropProjectPath}
          onSelect={props.selectEditorTab}
          onClose={props.requestCloseEditorTab}
          onSetPinned={props.setEditorTabPinned}
          onReorder={props.setOpenTabs}
        />
        {props.canvasToolbar}
        <div className="title-actions">
          <Tip label={building ? t`Stop the current LaTeX build` : props.buildPreferences.autoBuildMode === "automatic"
            ? t`Build automatically · Command-S builds now. Shift-click for clean rebuild`
            : t`Build only when requested · Command-S builds now. Shift-click for clean rebuild`}
          >
            <button
              aria-label={building ? t`Stop` : t`Build`}
              data-tour="build"
              className={`build-button ${building ? "stop" : build?.success ? "success" : ""}`}
              onClick={(event) => {
                if (building) void props.abortBuild();
                else if (event.shiftKey) void props.cleanAndRebuild();
                else void props.compile(false, true);
              }}
              disabled={!building && props.cleaning}
              aria-live="polite"
            >
              <StateSwap swapKey={building ? "building" : build?.success ? "success" : "idle"}>
                {building ? <Square size={13} fill="currentColor" /> : build?.success ? <Check size={15} /> : <Play size={15} />}
                <span className="build-button-label">
                  {building ? t`Stop` : build?.success ? `${(build.durationMs / 1000).toFixed(1)}s` : t`Build`}
                </span>
              </StateSwap>
            </button>
          </Tip>
        </div>
      </div>
    </header>
  );
}
