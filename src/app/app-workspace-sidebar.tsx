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
import { lazy, Suspense, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  BookMarked,
  BookOpen,
  Bot,
  ClipboardCheck,
  FolderTree,
  Library,
  PanelBottom,
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
import type { SynaraHost } from "./use-synara-host";
import type { SidebarMode, WorkspaceSidebar } from "./use-workspace-sidebar";
import type { AppLocale, Theme } from "../settings/app-settings";
import type { ProjectSnapshot } from "../app-types";

// The installed RadioGroup's Base UI dependency stays outside startup chunks.
const SynaraPermissionPicker = lazy(() => import("../agent/synara-permission-picker"));
const AppAgentPanel = lazy(() => import("./app-agent-panel"));

export type AppWorkspaceSidebarProps = {
  sidebar: Pick<WorkspaceSidebar,
    | "sidebarOpen" | "setSidebarOpen" | "sidebarWidth" | "sidebarResizing" | "beginSidebarResize" | "nudgeSidebar"
    | "sidebarMode" | "setSidebarMode" | "sidebarModeActionsRef" | "sidebarModeHeaderRef" | "sidebarModeTier"
    | "agentDocked" | "setAgentDocked"
  >;
  synara: SynaraHost;
  agentVisible: boolean;
  agentPanelDropActive: boolean;
  appLocale: AppLocale;
  theme: Theme;
  project: ProjectSnapshot;
  chooseSidebarMode: (mode: SidebarMode) => void;
  navigator: ReactNode;
  openBibEntryDialog: (resolveSeed?: string) => void;
  onCheckReferences: () => void;
  setLiteratureOpen: Dispatch<SetStateAction<boolean>>;
  openProjectFind: () => void;
  setProjectSearchOpen: Dispatch<SetStateAction<boolean>>;
  setBoardCreateRequest: Dispatch<SetStateAction<number>>;
  setPresentationCreateRequest: Dispatch<SetStateAction<number>>;
  setSpreadsheetCreateRequest: Dispatch<SetStateAction<number>>;
};

export function AppWorkspaceSidebar({ sidebar, synara, ...props }: AppWorkspaceSidebarProps) {
  const { t } = useLingui();
  const {
    sidebarMode, sidebarModeActionsRef, sidebarModeHeaderRef, sidebarOpen, sidebarWidth, agentDocked: docked,
  } = sidebar;
  const { origin: synaraOrigin, frameMounted, permissionMode, autoModeAvailable, changePermissionMode } = synara;
  const slotRef = useRef<HTMLDivElement>(null);
  const newDocumentItems = [
    { icon: <Table2 />, label: t`New spreadsheet`, request: props.setSpreadsheetCreateRequest },
    { icon: <Shapes />, label: t`New board`, request: props.setBoardCreateRequest },
    { icon: <Presentation />, label: t`New presentation`, request: props.setPresentationCreateRequest },
  ];
  return (
    <>
      <section className="shared-sidebar" data-tour="sidebar" inert={!sidebarOpen} aria-hidden={!sidebarOpen}>
        <div className="workspace-sidebar-content" style={{ width: sidebarWidth }}>
        <div ref={sidebarModeHeaderRef} className="sidebar-mode-header" data-mode-tier={sidebar.sidebarModeTier}>
          <SlidingTabs
            value={sidebarMode}
            onChange={(value) => props.chooseSidebarMode(value as SidebarMode)}
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
                    {newDocumentItems.map((item) => (
                      <DropdownMenuItem key={item.label} onSelect={() => item.request((request) => request + 1)}>
                        {item.icon}
                        {item.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tip label={t`Find in project`}>
                  <button
                    aria-label={t`Find in project`}
                    onClick={() => {
                      props.setProjectSearchOpen(false);
                      props.openProjectFind();
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
                  <button aria-label={t`Discover literature`} onClick={() => props.setLiteratureOpen(true)}>
                    <BookOpen size={14} />
                  </button>
                </Tip>
                <Tip label={t`Add bibliography entry`}>
                  <button onClick={() => props.openBibEntryDialog()}><BookMarked size={14} /></button>
                </Tip>
                <Tip label={t`Check references`}>
                  <button type="button" aria-label={t`Check references`} onClick={props.onCheckReferences}>
                    <ClipboardCheck size={14} aria-hidden="true" />
                  </button>
                </Tip>
              </>
            )}
            {sidebarMode === "agent" && (
              <>
                {synaraOrigin && <Suspense fallback={null}>
                  <SynaraPermissionPicker
                    value={permissionMode}
                    autoModeAvailable={autoModeAvailable}
                    onChange={changePermissionMode}
                  />
                </Suspense>}
                <Tip label={t`Move assistant below editor`}>
                  <button type="button" onClick={() => {
                    sidebar.setAgentDocked(true);
                    sidebar.setSidebarMode("project");
                    sidebar.setSidebarOpen(false);
                  }}><PanelBottom size={15} /></button>
                </Tip>
              </>
            )}
          </div>
        </div>
        <div className="sidebar-pane" data-tour="project-panel" hidden={sidebarMode === "agent"}>
          {props.navigator}
        </div>
        <div
          ref={slotRef}
          className={`sidebar-pane synara-sidebar-pane ${sidebarMode === "agent" && !docked ? "active" : ""}`}
          aria-hidden={sidebarMode !== "agent"}
        />
        </div>
      </section>
      {(frameMounted || docked || (sidebarOpen && sidebarMode === "agent")) && <Suspense fallback={null}>
        <AppAgentPanel
          docked={docked}
          visible={props.agentVisible}
          dropActive={props.agentPanelDropActive}
          appLocale={props.appLocale}
          theme={props.theme}
          projectRoot={props.project.root}
          synara={synara}
          onUndock={() => props.chooseSidebarMode("agent")}
          onClose={() => sidebar.setAgentDocked(false)}
          slotRef={slotRef}
        />
      </Suspense>}
      <PanelResizer
        label={t`Resize workspace sidebar`}
        value={sidebarWidth}
        open={sidebarOpen}
        resizing={sidebar.sidebarResizing}
        onCollapse={() => sidebar.setSidebarOpen(false)}
        onPointerDown={sidebar.beginSidebarResize}
        onNudge={sidebar.nudgeSidebar}
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
  const collapse = () => {
    props.onCollapse();
    document.querySelector<HTMLButtonElement>(".titlebar-sidebar-toggle button")?.focus();
  };
  const keyActions = new Map<string, () => void>([
    ["Enter", collapse],
    [" ", collapse],
    ["ArrowLeft", () => props.onNudge(-16)],
    ["ArrowRight", () => props.onNudge(16)],
  ]);
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
        const action = keyActions.get(event.key);
        if (!action) return;
        event.preventDefault();
        action();
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
