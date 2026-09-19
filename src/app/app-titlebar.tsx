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
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Bot,
  Check,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Square,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import { StateSwap } from "../components/ui/motion";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { EditorTabs, type EditorDropZone, type EditorTab } from "../canvas/editor-tabs";
import { ProjectMenu } from "../project/project-dialogs";
import { beginWindowDrag, toggleWindowFullscreen } from "../app-utils";
import type {
  BuildPreferences,
  RecentProject,
} from "../settings/app-settings";
import type {
  BuildResult,
  CanvasMode,
  ProjectSnapshot,
  SettingsTab,
} from "../app-types";

export type AppTitlebarProps = {
  agentOpen?: boolean;
  onToggleAgent?: () => void;
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
  compile: (force?: boolean, sound?: boolean, options?: { consumeAgentAssociations?: boolean; }) => Promise<void>;
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
  const {
    abortBuild,
    activeTabKey,
    build,
    building,
    buildPreferences,
    busyLabel,
    canvasMode,
    canvasToolbar,
    chooseExisting,
    chooseRecentProject,
    cleanAndRebuild,
    cleaning,
    compile,
    dropProjectPath,
    editorTabItems,
    exportProjectZip,
    importing,
    openSettings,
    openTutorialProject,
    project,
    projectMenuOpen,
    recentProjects,
    requestCloseEditorTab,
    selectEditorTab,
    setCreateError,
    setCreateOpen,
    setOpenTabs,
    setOverleafPickerOpen,
    setProjectMenuOpen,
    setSidebarOpen,
    sidebarOpen,
    sidebarResizing,
    sidebarWidth,
  } = props;
  return (
    <header className="titlebar" onMouseDown={beginWindowDrag} onDoubleClick={toggleWindowFullscreen}>
      <div className={`titlebar-sidebar ${sidebarOpen ? "" : "collapsed"}`} style={{ width: sidebarOpen ? sidebarWidth + 1 : undefined }}>
        <div className="titlebar-navigator">
          <div className="traffic-space" />
          <div className="titlebar-sidebar-toggle">
            <Tip label={sidebarOpen ? t`Hide sidebar` : t`Show sidebar`}>
              <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}>
                <span key={sidebarOpen ? "open" : "closed"} className="toggle-icon">
                  {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                </span>
              </button>
            </Tip>
          </div>
        </div>
        <div className="project-switcher">
          <DropdownMenu open={projectMenuOpen} onOpenChange={setProjectMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                className="project-title"
                aria-label={t`Switch project`}
                disabled={building || importing}
              >
                <span>{project.manifest.name}</span>
                <ChevronDown size={13} />
              </button>
            </DropdownMenuTrigger>
            <ProjectMenu
              currentPath={project.root}
              recentProjects={recentProjects}
              busyLabel={busyLabel}
              onRecent={chooseRecentProject}
              onOpen={() => void chooseExisting()}
              onNew={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
              onOpenOverleaf={() => setOverleafPickerOpen(true)}
              onOpenTutorial={() => void openTutorialProject()}
              onExportZip={() => void exportProjectZip()}
              onSettings={() => openSettings("appearance")}
            />
          </DropdownMenu>
          <div className="titlebar-drag-area" aria-hidden="true" />
        </div>
      </div>
      <div className="titlebar-main">
        <EditorTabs
          tabs={editorTabItems}
          activePath={activeTabKey}
          animateLayout={!sidebarResizing}
          canCloseLast={canvasMode === "pdf"}
          onDropTab={dropProjectPath}
          onSelect={selectEditorTab}
          onClose={requestCloseEditorTab}
          onReorder={setOpenTabs}
        />
        {canvasToolbar}
        <div className="title-actions">
          <Tip label={t`Toggle assistant`}>
            <button
              className="icon-button"
              aria-pressed={props.agentOpen ?? false}
              onClick={props.onToggleAgent}
            ><Bot size={16} /></button>
          </Tip>
          <Tip label={building ? t`Stop the current LaTeX build` : buildPreferences.autoBuildMode === "automatic"
            ? t`Build automatically · Command-S builds now. Shift-click for clean rebuild`
            : t`Build only when requested · Command-S builds now. Shift-click for clean rebuild`}
          >
            <button
              aria-label={building ? t`Stop` : t`Build`}
              data-tour="build"
              className={`build-button ${building ? "stop" : build?.success ? "success" : ""}`}
              onClick={(event) => {
                if (building) void abortBuild();
                else if (event.shiftKey) void cleanAndRebuild();
                else void compile(false, true);
              }}
              disabled={!building && cleaning}
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
