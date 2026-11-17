/**
 * Synara's project frames stay in the same Trellis content host when the
 * user switches projects, docks, floats or hides the panel. Moving an iframe
 * to another DOM parent would reload its document and sever its bridge.
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { AgentVisualDialog } from "../agent/agent-visual-dialog";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import { useSynaraConfirmationBridge } from "../agent/synara-confirmations";
import { useSynaraNotificationBridge } from "../agent/synara-notifications";
import { useSynaraPopupDismissalBridge } from "../agent/synara-popup-dismissal";
import { synaraEmbedUrl } from "../app/app-synara-embed";
import type { SynaraHost } from "../app/use-synara-host";
import type { SynaraProjectFrame } from "../app/use-synara-project-frames";
import { useTrellisAgentPlacement } from "./trellis-agent-placement";
import type { AppLocale, Theme } from "../settings/app-settings";

function ProjectAgentFrame({
  frame, origin, authToken, theme, appLocale, active, frameLoading, isFrameProjectActive, selectFrameProject,
}: {
  frame: SynaraProjectFrame;
  origin: string;
  authToken: string | null;
  theme: Theme;
  appLocale: AppLocale;
  active: boolean;
  frameLoading: SynaraHost["frameLoading"];
  isFrameProjectActive: SynaraHost["isFrameProjectActive"];
  selectFrameProject: SynaraHost["selectFrameProject"];
}) {
  const { t } = useLingui();
  const { root, ref, attempt } = frame;
  // Recording navigation must not change src and reload an in-progress turn.
  const src = useMemo(() =>
    synaraEmbedUrl({ origin, authToken, projectRoot: root, theme, locale: appLocale }),
  [origin, authToken, root, theme, appLocale]);
  const beforeAction = useCallback(() => selectFrameProject(root), [root, selectFrameProject]);
  useSynaraNotificationBridge({ frameRef: ref, origin, source: t`Synara agent`, beforeAction });
  const isActive = useCallback(() => isFrameProjectActive(root), [isFrameProjectActive, root]);
  useSynaraConfirmationBridge({ frameRef: ref, origin, canConfirm: isActive });
  useSynaraPopupDismissalBridge({ frameRef: ref, origin, isActive });
  useLayoutEffect(() => {
    frameLoading(root);
    return () => frameLoading(root);
  }, [attempt, frameLoading, root, src]);
  return (
    <iframe
      key={attempt}
      ref={ref}
      className="synara-poc-frame"
      src={src}
      title={t`Agent`}
      hidden={!active}
      allow="clipboard-read; clipboard-write; microphone"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
    />
  );
}

function TrellisAgentSurface({ synara, projectRoot, theme, appLocale, dropActive, anchor, onPointerEnter }: {
  synara: SynaraHost;
  projectRoot: string;
  theme: Theme;
  appLocale: AppLocale;
  dropActive: boolean;
  anchor?: HTMLElement;
  onPointerEnter?: () => void;
}) {
  const {
    origin, runtime, frames, frameMounted, frameReady, frameLoading, isFrameProjectActive, selectFrameProject,
    retryAgent, expandedVisual, closeExpandedVisual,
  } = synara;
  const layerRef = useRef<HTMLDivElement>(null);
  useTrellisAgentPlacement(layerRef, anchor);
  return (
    <div
      ref={layerRef}
      className={`synara-frame-shell ${anchor ? "trellis-agent-layer" : ""} ${dropActive ? "agent-drop-active" : ""}`}
      data-tour="agent-panel"
      data-ready={frameReady || undefined}
      onPointerEnter={onPointerEnter}
    >
      {origin && frames.map((frame) => (
        <ProjectAgentFrame
          key={`${frame.root}\0${origin}\0${runtime.authToken ?? ""}`}
          frame={frame}
          origin={origin}
          authToken={runtime.authToken}
          theme={theme}
          appLocale={appLocale}
          active={frame.root === projectRoot}
          frameLoading={frameLoading}
          isFrameProjectActive={isFrameProjectActive}
          selectFrameProject={selectFrameProject}
        />
      ))}
      {!frameReady && <SynaraLoadingSurface thread waiting={frameMounted} runtime={runtime} preparingWorkspace={Boolean(origin)} onRetry={retryAgent} />}
      {expandedVisual && <AgentVisualDialog visual={expandedVisual} theme={theme} onClose={closeExpandedVisual} />}
    </div>
  );
}

export default TrellisAgentSurface;
