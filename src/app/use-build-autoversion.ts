import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, OverleafLink } from "../app-types";
import { AUTO_COMMIT_MESSAGES } from "../history/version-messages";

/**
 * Version successful builds of linked projects at most every 2 minutes.
 * Unlinked projects never get surprise commits in a repo managed by hand.
 */
export function useBuildAutoversion(build: BuildResult | null, overleafLink: OverleafLink | null) {
  const lastAutoVersionRef = useRef(0);
  useEffect(() => {
    if (!build?.success || !overleafLink) return;
    const now = Date.now();
    if (now - lastAutoVersionRef.current < 120_000) return;
    lastAutoVersionRef.current = now;
    void invoke<string | null>("git_auto_commit", {
      message: AUTO_COMMIT_MESSAGES.autoSaved, author: null,
    }).catch(() => {});
  }, [build, overleafLink]);
}
