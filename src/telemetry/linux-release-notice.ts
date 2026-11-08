/** Linux AppImages are updated by hand. Offer the fixed releases page when
 * the host finds a newer release; never ask the updater plugin to install it. */
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { addAppLog } from "./app-log-store";
import { updatesItself } from "./updates-itself";

const RELEASES = "https://github.com/leo1oel/lattice/releases/latest";

export function useLinuxReleaseNotice(intervalMs: number, enabled: boolean) {
  const offered = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || updatesItself()) return;
    let disposed = false;
    let checking = false;
    const check = () => {
      if (checking) return;
      checking = true;
      void invoke<string | null>("check_linux_release").then((version) => {
        if (disposed || !version || version === offered.current || version.length > 32 || !/^\d+\.\d+\.\d+$/.test(version)) return;
        offered.current = version;
        addAppLog({
          level: "info",
          source: i18n._(msg`App updater`),
          title: i18n._(msg`New version ${version}`),
          detail: i18n._(msg`Lattice on Linux doesn’t update itself. Download new versions from GitHub Releases.`),
          dedupeKey: "linux-release-notice",
          toastOptions: {
            timeoutMs: 0,
            primaryAction: { label: i18n._(msg`GitHub Releases`), onClick: () => { void openUrl(RELEASES).catch(() => undefined); } },
          },
        });
      }, () => {
        // No desktop host or temporarily offline: retry at the next interval.
      }).finally(() => { checking = false; });
    };
    void check();
    const timer = window.setInterval(() => void check(), intervalMs);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [enabled, intervalMs]);
}
