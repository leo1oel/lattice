/**
 * The Agent island's `settings` surface: Settings › Providers, Synara's own
 * settings page for the open project, as the Tauri app's Settings dialog
 * hosts it (`src/settings/settings-dialog.tsx`, `synara-settings-pane.tsx`).
 * The page is the dialog's content column: its scroll area here is the one
 * the Tauri dialog's page scrolls in, and the pane sizes the frame and
 * forwards its wheel to it exactly as it does there.
 */
import { useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { ScrollArea } from "../../../src/components/ui/scroll-area";
import { SynaraSettingsPane } from "../../../src/settings/synara-settings-pane";
import { useSynaraRuntime } from "../../../src/agent/use-synara-runtime";
import { synaraFrameUrl } from "../../../src/agent/synara-runtime";
import type { ThemeAccent, ThemeTint, Translucency } from "../../../src/settings/theme-customization";

export type SettingsLayout = {
  /** Settings' compact insets (the GPUI dialog in its narrow form). */
  compact: boolean;
  /** A place on the page to open and reveal; a fresh object per request. */
  target: { target: string } | null;
};

export function SettingsSurface(props: {
  projectRoot: string;
  locale: "en" | "zh-CN";
  theme: "light" | "dark";
  tint: ThemeTint;
  appearance: { translucency: Translucency; translucent: boolean; accent: ThemeAccent };
  layout: SettingsLayout;
}) {
  const { t } = useLingui();
  const { runtime, retry } = useSynaraRuntime(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const url = runtime.state === "ready" && runtime.origin
    ? synaraFrameUrl({
      origin: runtime.origin,
      path: "/settings",
      workspaceRoot: props.projectRoot,
      theme: props.theme,
      locale: props.locale,
      surface: "drawer",
      hostOrigin: window.location.origin,
      authToken: runtime.authToken,
    })
    : null;
  return (
    <ScrollArea className="settings-content agent-island-host" viewportRef={viewportRef} fadeEdges={false}>
      <SynaraSettingsPane
        runtime={runtime}
        section="providers"
        url={url}
        synaraSettingsLabel={t`Providers`}
        viewportRef={viewportRef}
        appearance={{ theme: props.theme, tint: props.tint, ...props.appearance }}
        target={props.layout.target}
        compact={props.layout.compact}
        onRetry={retry}
      />
    </ScrollArea>
  );
}
