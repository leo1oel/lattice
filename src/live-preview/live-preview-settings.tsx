/**
 * Settings › Builds: the LuaLaTeX live preview switch, for a LuaLaTeX project
 * only, and removing the rtex it downloaded. It is on by default, so this is
 * also where a Mac that cannot run it, or a download that failed, is
 * explained: the PDF panel shows neither.
 */
import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../components/ui/button";
import { SettingsRow } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import { toMessage } from "../app-utils";
import type { LivePreview, LivePreviewInstall } from "./use-live-preview";

export function LivePreviewSettings({ livePreview }: { livePreview: LivePreview }) {
  const { t } = useLingui();
  const { available, enabled, state } = livePreview;
  const [install, setInstall] = useState<LivePreviewInstall | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Asked again whenever the preview changes state: a download that just
  // finished has put rtex in place.
  useEffect(() => {
    let current = true;
    void invoke<LivePreviewInstall>("live_preview_status")
      .then((status) => { if (current) setInstall(status); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [state.kind]);

  const about = t`Redraws the paragraph you type in the PDF within milliseconds, with rtex and your own LuaLaTeX. Downloads rtex (about 4 MB) the first time. Exported PDFs, errors and jumps to the source still come from the normal build.`;
  const percent = state.kind === "downloading" ? Math.round(state.progress * 100) : 0;
  const message = state.kind === "failed" || state.kind === "download-failed" ? state.message : "";
  const unavailable = install?.supported === false
    ? t`Live preview needs a Mac with Apple silicon. Builds work as usual.`
    : install?.lualatex === false
      ? t`Live preview needs LuaLaTeX, and Lattice could not run it. Builds work as usual. Install TeX Live or BasicTeX, then open the project again.`
      : null;
  const description = unavailable ?? (state.kind === "downloading"
    ? t`Downloading rtex… ${percent}%`
    : state.kind === "failed" ? t`Could not start: ${message}` : about);
  const version = install?.version ?? "";
  const remove = () => {
    setRemoving(true);
    setRemoveError(null);
    livePreview.remove()
      .then(setInstall, (reason: unknown) => setRemoveError(toMessage(reason)))
      .finally(() => setRemoving(false));
  };
  return (
    <>
      {available && (
        <SwitchField
          data-setting="live-preview"
          label={t`Live preview`}
          description={description}
          checked={enabled && !unavailable}
          disabled={Boolean(unavailable)}
          onChange={livePreview.setEnabled}
        />
      )}
      {available && state.kind === "download-failed" && (
        <SettingsRow
          data-setting="live-preview-engine"
          label={t`Live preview engine`}
          description={t`${message} Builds work as usual.`}
        >
          <Button size="compact" onClick={livePreview.retry}>{t`Retry`}</Button>
        </SettingsRow>
      )}
      {install?.installed && (
        <SettingsRow
          data-setting="live-preview-engine"
          label={t`Live preview engine`}
          description={removeError ?? t`rtex ${version} is downloaded. Removing it turns live preview off in every project.`}
        >
          <Button size="compact" disabled={removing} onClick={remove}>
            {removing ? t`Removing…` : t`Remove`}
          </Button>
        </SettingsRow>
      )}
    </>
  );
}
