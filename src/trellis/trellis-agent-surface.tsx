/**
 * The agent panel's content under Trellis: just the Synara frame. Trellis never
 * reparents view content, so the iframe (and its running session) survives
 * docking, floating, hiding and zooming. It is never hibernated.
 */
import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import { synaraEmbedUrl } from "../app/app-synara-embed";
import type { SynaraHost } from "../app/use-synara-host";
import type { AppLocale, Theme } from "../settings/app-settings";

export function TrellisAgentSurface({ synara, projectRoot, theme, appLocale, dropActive }: {
  synara: SynaraHost;
  projectRoot: string;
  theme: Theme;
  appLocale: AppLocale;
  dropActive: boolean;
}) {
  const { t } = useLingui();
  const { origin, runtime, frameMounted, frameReady, frameRef, retry } = synara;
  // Recording navigation must not change src and reload an in-progress turn.
  const src = useMemo(() => origin
    ? synaraEmbedUrl({ origin, authToken: runtime.authToken, projectRoot, theme, locale: appLocale })
    : undefined,
  [origin, runtime.authToken, projectRoot, theme, appLocale]);
  return (
    <div className={`synara-frame-shell ${dropActive ? "agent-drop-active" : ""}`} data-tour="agent-panel" data-ready={frameReady || undefined}>
      {frameMounted && origin && <iframe
        key={projectRoot}
        ref={frameRef}
        className="synara-poc-frame"
        src={src}
        title={t`Agent`}
        allow="clipboard-read; clipboard-write; microphone"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      />}
      {!frameReady && <SynaraLoadingSurface runtime={runtime} preparingWorkspace={Boolean(origin)} onRetry={retry} />}
    </div>
  );
}

export default TrellisAgentSurface;
