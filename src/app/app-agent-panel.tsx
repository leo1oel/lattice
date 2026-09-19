import { useMemo, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { Bot, PanelLeftOpen, X } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import SynaraPermissionPicker from "../agent/synara-permission-picker";
import { synaraEmbedUrl } from "./app-synara-embed";
import { useAgentPanelLayout } from "./use-agent-panel-layout";
import type { AppWorkspaceSidebarProps } from "./app-workspace-sidebar";
import "./agent-panel-layout.css";

type Props = Pick<AppWorkspaceSidebarProps,
  | "agentDocked" | "onCloseAgentDock" | "agentPanelDropActive" | "appLocale"
  | "changeSynaraPermissionMode" | "chooseSidebarMode" | "project" | "retrySynaraRuntime"
  | "sidebarOpen" | "sidebarMode" | "synaraAutoModeAvailable" | "synaraFrameMounted"
  | "synaraFrameReady" | "synaraIframeRef" | "synaraOrigin" | "synaraPermissionMode"
  | "synaraRuntime" | "theme"
> & { slotRef: RefObject<HTMLDivElement | null> };

/** Loaded on the first assistant request, then kept mounted for its lifetime. */
export default function AppAgentPanel(props: Props) {
  const { t } = useLingui();
  const {
    appLocale, project, synaraOrigin, synaraRuntime, theme,
    synaraFrameMounted, synaraFrameReady, synaraIframeRef,
  } = props;
  // Recording navigation must not change src and reload an in-progress turn.
  const agentFrameUrl = useMemo(() => synaraOrigin
    ? synaraEmbedUrl(synaraOrigin, synaraRuntime.authToken, project.root, theme, appLocale)
    : undefined,
  [synaraOrigin, synaraRuntime.authToken, project.root, theme, appLocale]);
  const docked = props.agentDocked ?? false;
  const visible = docked || (props.sidebarOpen && props.sidebarMode === "agent");
  const { panelRef, ratio, resize, beginResize, moveResize } = useAgentPanelLayout(docked, visible, props.slotRef);
  return <div ref={panelRef} className="agent-panel-surface" inert={!visible} aria-hidden={!visible}>
    {docked && <>
      <div
        className="agent-dock-resizer"
        role="separator"
        aria-label={t`Resize editor and assistant`}
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={65}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            resize(ratio + (event.key === "ArrowUp" ? 0.05 : -0.05));
          }
        }}
      />
      <div className="agent-dock-header">
        <Bot size={14} /><span>{t`Agent`}</span>
        {synaraOrigin && <SynaraPermissionPicker
          value={props.synaraPermissionMode}
          autoModeAvailable={props.synaraAutoModeAvailable}
          onChange={props.changeSynaraPermissionMode}
        />}
        <Tip label={t`Move assistant to sidebar`}>
          <button className="icon-button" aria-label={t`Move assistant to sidebar`} onClick={() => props.chooseSidebarMode("agent")}><PanelLeftOpen size={14} /></button>
        </Tip>
        <Tip label={t`Hide assistant`}>
          <button className="icon-button" aria-label={t`Hide assistant`} onClick={props.onCloseAgentDock}><X size={14} /></button>
        </Tip>
      </div>
    </>}
    <div
      className={`synara-frame-shell ${props.agentPanelDropActive ? "agent-drop-active" : ""}`}
      data-tour="agent-panel"
      data-ready={synaraFrameReady || undefined}
    >
      {synaraFrameMounted && synaraOrigin && <iframe
        key={project.root}
        ref={synaraIframeRef}
        className="synara-poc-frame"
        src={agentFrameUrl}
        title={t`Agent`}
        allow="clipboard-read; clipboard-write; microphone"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      />}
      {!synaraFrameReady && <SynaraLoadingSurface
        runtime={synaraRuntime}
        preparingWorkspace={Boolean(synaraOrigin)}
        onRetry={props.retrySynaraRuntime}
      />}
    </div>
  </div>;
}
