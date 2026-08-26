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
import { type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  BookMarked,
  BookOpen,
  Bot,
  FolderTree,
  Library,
  Plus,
  Presentation,
  Search,
  Shapes,
  Shield,
  ShieldCheck,
  Table2,
  Hand,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { SlidingTabs } from "../components/ui/motion";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import { isSynaraPermissionMode, synaraEmbedUrl, type SynaraPermissionMode } from "./app-synara-embed";
import { type SidebarModeTier } from "./sidebar-mode-layout";
import type { SynaraRuntimeInfo } from "../agent/synara-runtime";
import type { ProjectFindHit } from "../project/project-find-dialog";
import type { AppLocale, Theme } from "../settings/app-settings";
import type { ProjectSnapshot } from "../app-types";

const SYNARA_PERMISSION_PRESENTATION: Record<
  SynaraPermissionMode,
  { label: string; description: string }
> = {
  "full-access": {
    label: "Full access",
    description: "Run without asking for approval",
  },
  auto: {
    label: "Approve for me",
    description: "Ask only for potentially unsafe actions",
  },
  "approval-required": {
    label: "Ask for approval",
    description: "Ask before external edits and network access",
  },
};

function SynaraPermissionIcon({ mode }: { mode: SynaraPermissionMode }) {
  if (mode === "full-access") return <ShieldCheck size={14} />;
  if (mode === "auto") return <Shield size={14} />;
  return <Hand size={14} />;
}

function SynaraPermissionPicker(props: {
  value: SynaraPermissionMode;
  autoModeAvailable: boolean;
  onChange: (value: SynaraPermissionMode) => void;
}) {
  const presentation = SYNARA_PERMISSION_PRESENTATION[props.value];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="agent-permission-trigger"
          aria-label={`Agent permissions: ${presentation.label}`}
          title={`Agent permissions: ${presentation.label}`}
        >
          <SynaraPermissionIcon mode={props.value} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="agent-permission-menu">
        <DropdownMenuRadioGroup value={props.value} onValueChange={(value) => {
          if (isSynaraPermissionMode(value)) props.onChange(value);
        }}>
          {(["full-access", "auto", "approval-required"] as const).map((mode) => {
            const option = SYNARA_PERMISSION_PRESENTATION[mode];
            return (
              <DropdownMenuRadioItem
                key={mode}
                value={mode}
                disabled={mode === "auto" && !props.autoModeAvailable}
                className="ui-radio-choice"
              >
                <span className="ui-radio-dot" aria-hidden="true" />
                <span className="agent-permission-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type AppWorkspaceSidebarProps = {
  agentPanelDropActive: boolean;
  appLocale: AppLocale;
  beginSidebarResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  changeSynaraPermissionMode: (mode: SynaraPermissionMode) => void;
  chooseSidebarMode: (mode: "project" | "papers" | "agent") => void;
  navigator: ReactNode;
  nudgeSidebar: (delta: number) => void;
  openBibEntryDialog: (resolveSeed?: string) => void;
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
      <section className="shared-sidebar" data-tour="sidebar">
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
                    <button aria-label={t`New document`} title={t`New document`}>
                      <Plus size={14} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={6}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    <DropdownMenuItem onSelect={() => setPresentationCreateRequest((request) => request + 1)}>
                      <Presentation />
                      {t`New presentation`}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setSpreadsheetCreateRequest((request) => request + 1)}>
                      <Table2 />
                      {t`New spreadsheet`}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setBoardCreateRequest((request) => request + 1)}>
                      <Shapes />
                      {t`New board`}
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
              </>
            )}
            {sidebarMode === "agent" && synaraOrigin && (
              <SynaraPermissionPicker
                value={synaraPermissionMode}
                autoModeAvailable={synaraAutoModeAvailable}
                onChange={changeSynaraPermissionMode}
              />
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
      </section>
      <PanelResizer
        label={t`Resize workspace sidebar`}
        value={sidebarWidth}
        onPointerDown={beginSidebarResize}
        onNudge={nudgeSidebar}
      />
    </>
  );
}

function PanelResizer(props: {
  label: string;
  value: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <div
      className="panel-resizer sidebar-resizer"
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(props.value)}
      tabIndex={0}
      onPointerDown={props.onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          props.onNudge(-16);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onNudge(16);
        }
      }}
    />
  );
}
