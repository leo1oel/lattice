import { useMemo, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { Bot, PanelLeftOpen, X } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import SynaraPermissionPicker from "../agent/synara-permission-picker";
import { synaraEmbedUrl } from "./app-synara-embed";
import { useAgentPanelLayout } from "./use-agent-panel-layout";
import type { AppLocale, Theme } from "../settings/app-settings";
import type { SynaraHost } from "./use-synara-host";
import "./agent-panel-layout.css";

/** Loaded on the first assistant request, then kept mounted for its lifetime. */
export default function AppAgentPanel({ docked, visible, dropActive, appLocale, theme, projectRoot, synara, onUndock, onClose, slotRef }: {
  docked: boolean;
  visible: boolean;
  dropActive: boolean;
  appLocale: AppLocale;
  theme: Theme;
  projectRoot: string;
  synara: SynaraHost;
  onUndock: () => void;
  onClose: () => void;
  slotRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useLingui();
  const {
    origin: synaraOrigin, runtime: synaraRuntime, frameMounted, frameReady, frameRef, retry,
    permissionMode, autoModeAvailable, changePermissionMode,
  } = synara;
  // Recording navigation must not change src and reload an in-progress turn.
  const agentFrameUrl = useMemo(() => synaraOrigin
    ? synaraEmbedUrl({ origin: synaraOrigin, authToken: synaraRuntime.authToken, projectRoot, theme, locale: appLocale })
    : undefined,
  [synaraOrigin, synaraRuntime.authToken, projectRoot, theme, appLocale]);
  const { panelRef, ratio, resize, beginResize, moveResize } = useAgentPanelLayout(docked, visible, slotRef);
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
          value={permissionMode}
          autoModeAvailable={autoModeAvailable}
          onChange={changePermissionMode}
        />}
        <Tip label={t`Move assistant to sidebar`}>
          <button className="icon-button" aria-label={t`Move assistant to sidebar`} onClick={onUndock}><PanelLeftOpen size={14} /></button>
        </Tip>
        <Tip label={t`Hide assistant`}>
          <button className="icon-button" aria-label={t`Hide assistant`} onClick={onClose}><X size={14} /></button>
        </Tip>
      </div>
    </>}
    <div
      className={`synara-frame-shell ${dropActive ? "agent-drop-active" : ""}`}
      data-tour="agent-panel"
      data-ready={frameReady || undefined}
    >
      {frameMounted && synaraOrigin && <iframe
        key={projectRoot}
        ref={frameRef}
        className="synara-poc-frame"
        src={agentFrameUrl}
        title={t`Agent`}
        allow="clipboard-read; clipboard-write; microphone"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      />}
      {!frameReady && <SynaraLoadingSurface
        runtime={synaraRuntime}
        preparingWorkspace={Boolean(synaraOrigin)}
        onRetry={retry}
      />}
    </div>
  </div>;
}
