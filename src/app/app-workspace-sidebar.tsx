/**
 * The workspace sidebar: the project/papers/agent mode tabs with their
 * per-mode action buttons, the pane the file navigator lives in, the agent's
 * embedded frame, and the resizer between the sidebar and the canvas.
 *
 * The navigator arrives as an element for the same reason the canvas toolbar
 * does in `app-titlebar.tsx`: it reads about forty of App's values that nothing
 * else in the sidebar touches, and it is behind `lazy()`, so the element has to
 * be created where the loader lives.
 */
import { lazy, Suspense, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  BookMarked,
  BookOpen,
  Bot,
  ClipboardCheck,
  FolderTree,
  Library,
  Plus,
  Presentation,
  Search,
  Shapes,
  Table2,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { SlidingTabs } from "../components/ui/motion";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import { synaraEmbedUrl, type SynaraPermissionMode } from "./app-synara-embed";
import { type SidebarModeTier } from "./sidebar-mode-layout";
import type { SynaraRuntimeInfo } from "../agent/synara-runtime";
import type { ProjectFindHit } from "../project/project-find-dialog";
import type { AppLocale, Theme } from "../settings/app-settings";
import type { ProjectSnapshot } from "../app-types";

// The installed RadioGroup's Base UI dependency stays outside startup chunks.
const SynaraPermissionPicker = lazy(() => import("../agent/synara-permission-picker"));

export type AppWorkspaceSidebarProps = {
  agentPanelDropActive: boolean;
  appLocale: AppLocale;
  beginSidebarResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  changeSynaraPermissionMode: (mode: SynaraPermissionMode) => void;
  chooseSidebarMode: (mode: "project" | "papers" | "agent") => void;
  navigator: ReactNode;
  nudgeSidebar: (delta: number) => void;
  openBibEntryDialog: (resolveSeed?: string) => void;
  onCheckReferences: () => void;
  project: ProjectSnapshot;
  retrySynaraRuntime: () => void;
  setBoardCreateRequest: Dispatch<SetStateAction<number>>;
  setLiteratureOpen: Dispatch<SetStateAction<boolean>>;
  setProjectFindError: Dispatch<SetStateAction<string | null>>;
  setProjectFindHits: Dispatch<SetStateAction<ProjectFindHit[]>>;
  setProjectFindOpen: Dispatch<SetStateAction<boolean>>;
  setProjectSearchOpen: Dispatch<SetStateAction<boolean>>;
  setPresentationCreateRequest: Dispatch<SetStateAction<number>>;
  setSpreadsheetCreateRequest: Dispatch<SetStateAction<number>>;
  sidebarMode: "agent" | "project" | "papers";
  sidebarModeActionsRef: RefObject<HTMLDivElement | null>;
  sidebarModeHeaderRef: RefObject<HTMLDivElement | null>;
  sidebarModeTier: SidebarModeTier;
  sidebarWidth: number;
  sidebarOpen: boolean;
  sidebarResizing: boolean;
  onCollapseSidebar: () => void;
  synaraAutoModeAvailable: boolean;
  synaraFrameMounted: boolean;
  synaraFrameReady: boolean;
  synaraIframeRef: RefObject<HTMLIFrameElement | null>;
  synaraOrigin: string | null;
  synaraPermissionMode: SynaraPermissionMode;
  synaraRuntime: SynaraRuntimeInfo;
  theme: Theme;
};

export function AppWorkspaceSidebar(props: AppWorkspaceSidebarProps) {
  const { t } = useLingui();
  const {
    agentPanelDropActive,
    appLocale,
    beginSidebarResize,
    changeSynaraPermissionMode,
    chooseSidebarMode,
    navigator,
    nudgeSidebar,
    openBibEntryDialog,
    onCheckReferences,
    project,
    retrySynaraRuntime,
    setBoardCreateRequest,
    setLiteratureOpen,
    setProjectFindError,
    setProjectFindHits,
    setProjectFindOpen,
    setProjectSearchOpen,
    setPresentationCreateRequest,
    setSpreadsheetCreateRequest,
    sidebarMode,
    sidebarModeActionsRef,
    sidebarModeHeaderRef,
    sidebarModeTier,
    sidebarWidth,
    synaraAutoModeAvailable,
    synaraFrameMounted,
    synaraFrameReady,
    synaraIframeRef,
    synaraOrigin,
    synaraPermissionMode,
    synaraRuntime,
    theme,
  } = props;
  return (
    <>
      <section className="shared-sidebar" data-tour="sidebar" inert={!props.sidebarOpen} aria-hidden={!props.sidebarOpen}>
        <div className="workspace-sidebar-content" style={{ width: sidebarWidth }}>
        <div ref={sidebarModeHeaderRef} className="sidebar-mode-header" data-mode-tier={sidebarModeTier}>
          <SlidingTabs
            value={sidebarMode}
            onChange={(value) => chooseSidebarMode(value as "project" | "papers" | "agent")}
            ariaLabel={t`Sidebar mode`}
            className="sidebar-mode-tabs"
            items={[
              { value: "project", title: t`Project`, label: <><FolderTree size={15} /><span>{t`Project`}</span></> },
              { value: "papers", title: t`Papers`, dataTour: "papers-tab", label: <><Library size={15} /><span>{t`Papers`}</span></> },
              { value: "agent", title: t`Agent`, dataTour: "agent-tab", label: <><Bot size={15} /><span>{t`Agent`}</span></> },
            ]}
          />
          <div ref={sidebarModeActionsRef} className="sidebar-mode-actions">
            {sidebarMode === "project" && (
              <>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button aria-label={t`New document`} title={t`New document`} data-tour="new-document">
                      <Plus size={14} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={6}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    <DropdownMenuItem onSelect={() => setSpreadsheetCreateRequest((request) => request + 1)}>
                      <Table2 />
                      {t`New spreadsheet`}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setBoardCreateRequest((request) => request + 1)}>
                      <Shapes />
                      {t`New board`}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPresentationCreateRequest((request) => request + 1)}>
                      <Presentation />
                      {t`New presentation`}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tip label={t`Find in project`}>
                  <button
                    aria-label={t`Find in project`}
                    onClick={() => {
                      setProjectSearchOpen(false);
                      setProjectFindError(null);
                      setProjectFindHits([]);
                      setProjectFindOpen(true);
                    }}
                  >
                    <Search size={13} />
                  </button>
                </Tip>
              </>
            )}
            {sidebarMode === "papers" && (
              <>
                <Tip label={t`Discover literature`}>
                  <button aria-label={t`Discover literature`} onClick={() => setLiteratureOpen(true)}>
                    <BookOpen size={14} />
                  </button>
                </Tip>
                <Tip label={t`Add bibliography entry`}>
                  <button onClick={() => openBibEntryDialog()}><BookMarked size={14} /></button>
                </Tip>
                <Tip label={t`Check references`}>
                  <button type="button" aria-label={t`Check references`} onClick={onCheckReferences}>
                    <ClipboardCheck size={14} aria-hidden="true" />
                  </button>
                </Tip>
              </>
            )}
            {sidebarMode === "agent" && synaraOrigin && (
              <Suspense fallback={null}>
                <SynaraPermissionPicker
                  value={synaraPermissionMode}
                  autoModeAvailable={synaraAutoModeAvailable}
                  onChange={changeSynaraPermissionMode}
                />
              </Suspense>
            )}
          </div>
        </div>
        <div className="sidebar-pane" data-tour="project-panel" hidden={sidebarMode === "agent"}>
          {navigator}
        </div>
        <div
          className={`sidebar-pane synara-sidebar-pane ${sidebarMode === "agent" ? "active" : ""}`}
          aria-hidden={sidebarMode !== "agent"}
        >
          <div
            className={`synara-frame-shell ${agentPanelDropActive ? "agent-drop-active" : ""}`}
            data-tour="agent-panel"
            data-ready={synaraFrameReady || undefined}
          >
            {synaraFrameMounted && synaraOrigin && (
              <iframe
                ref={synaraIframeRef}
                className="synara-poc-frame"
                src={synaraEmbedUrl(
                  synaraOrigin,
                  synaraRuntime.authToken,
                  project.root,
                  theme,
                  appLocale,
                )}
                title={t`Agent`}
                allow="clipboard-read; clipboard-write; microphone"
                sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
              />
            )}
            {!synaraFrameReady && (
              <SynaraLoadingSurface
                runtime={synaraRuntime}
                preparingWorkspace={Boolean(synaraOrigin)}
                onRetry={retrySynaraRuntime}
              />
            )}
          </div>
        </div>
        </div>
      </section>
      <PanelResizer
        label={t`Resize workspace sidebar`}
        value={sidebarWidth}
        open={props.sidebarOpen}
        resizing={props.sidebarResizing}
        onCollapse={props.onCollapseSidebar}
        onPointerDown={beginSidebarResize}
        onNudge={nudgeSidebar}
      />
    </>
  );
}

function PanelResizer(props: {
  label: string;
  value: number;
  open: boolean;
  resizing: boolean;
  onCollapse: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onNudge: (delta: number) => void;
}) {
  const { t } = useLingui();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [pointerOffset, setPointerOffset] = useState<number | null>(null);
  return (
    <TooltipProvider delayDuration={280}>
    <Tooltip open={tooltipOpen && !props.resizing && props.open} onOpenChange={setTooltipOpen}>
    <TooltipTrigger asChild>
    <div
      className="panel-resizer sidebar-resizer"
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(props.value)}
      aria-hidden={!props.open}
      tabIndex={props.open ? 0 : -1}
      onPointerDown={props.onPointerDown}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") setPointerOffset(event.clientY - event.currentTarget.getBoundingClientRect().top);
      }}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) setPointerOffset(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onCollapse();
          document.querySelector<HTMLButtonElement>(".titlebar-sidebar-toggle button")?.focus();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          props.onNudge(-16);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onNudge(16);
        }
      }}
    />
    </TooltipTrigger>
    <TooltipContent side="right" sideOffset={8} align={pointerOffset === null ? "center" : "start"} alignOffset={pointerOffset ?? 0}>
      <div>{t`Drag to resize`}</div>
      <div>{t`Click to collapse`}</div>
    </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  );
}
