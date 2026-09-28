import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS, type LocalSemanticSearchStatus } from "../project/project-semantic-search";
import { LOCAL_SEMANTIC_SEARCH_KEY, loadLocalSemanticSearchEnabled, persistLocalSemanticSearchEnabled } from "../settings/app-settings";
import { subscribeTauriEvent } from "./effect-helpers";

function cancelSemanticIndex(projectRef: RefObject<ProjectSnapshot | null>) {
  const projectRoot = projectRef.current?.root;
  if (projectRoot) void invoke("semantic_search_cancel", { projectRoot }).catch(() => undefined);
}

/**
 * The opt-in on-device semantic index of the open project: the app-global
 * preference, background (re)indexing as files change, and its status.
 */
export function useLocalSemanticSearch(
  projectRoot: string | undefined,
  projectRef: RefObject<ProjectSnapshot | null>,
) {
  const [enabled, setEnabled] = useState(loadLocalSemanticSearchEnabled);
  const [status, setStatus] = useState(DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS);
  const [revision, setRevision] = useState(0);
  const reindexTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // The preference is app-global: other windows mirror a change through the
    // storage event and clear the index of their own open project.
    const syncPreference = (event: StorageEvent) => {
      if (event.key !== LOCAL_SEMANTIC_SEARCH_KEY) return;
      const next = event.newValue === "1";
      setEnabled(next);
      if (!next) cancelSemanticIndex(projectRef);
    };
    window.addEventListener("storage", syncPreference);
    return () => window.removeEventListener("storage", syncPreference);
  }, [projectRef]);

  const changeEnabled = useCallback((next: boolean) => {
    setEnabled(next);
    persistLocalSemanticSearchEnabled(next);
    if (!next) cancelSemanticIndex(projectRef);
  }, [projectRef]);

  const requestReindex = useCallback(() => {
    if (!enabled) return;
    if (reindexTimerRef.current !== null) window.clearTimeout(reindexTimerRef.current);
    // One save/build can still produce several coalesced bursts; a trailing
    // request avoids restarting the background generation while files settle.
    reindexTimerRef.current = window.setTimeout(() => {
      reindexTimerRef.current = null;
      setRevision((current) => current + 1);
    }, 750);
  }, [enabled]);
  useEffect(() => () => {
    if (reindexTimerRef.current !== null) window.clearTimeout(reindexTimerRef.current);
    reindexTimerRef.current = null;
  }, [enabled, projectRoot]);

  useEffect(() => {
    if (!enabled || !projectRoot) return;
    // Freshness must not depend on the Project sidebar being visible: reuse the
    // root watcher, with a listener separate from tree refreshes.
    void invoke("watch_project").catch(() => undefined);
    return subscribeTauriEvent<{ root: string }>("project-fs-changed", (payload) => {
      if (payload.root === projectRoot) requestReindex();
    });
  }, [enabled, projectRoot, requestReindex]);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | null = null;
    const acceptStatus = (next: LocalSemanticSearchStatus | null | undefined) => {
      if (stopped || !next || typeof next.state !== "string") return;
      setStatus(next);
      if (next.state !== "indexing") return;
      pollTimer = window.setTimeout(() => {
        void invoke<LocalSemanticSearchStatus>("semantic_search_status", { projectRoot }).then(acceptStatus).catch(() => {
          if (!stopped) setStatus((current) => ({ ...current, state: "error", detail: "The local semantic index could not be checked" }));
        });
      }, 500);
    };
    if (!projectRoot || !enabled) {
      setStatus(DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS);
    } else {
      setStatus((current) => ({ ...current, state: "indexing", detail: "Building an on-device index in the background" }));
      void invoke<LocalSemanticSearchStatus>("semantic_search_start_index", { projectRoot }).then(acceptStatus).catch((reason) => {
        if (!stopped) setStatus({ ...DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS, state: "error", detail: toMessage(reason) });
      });
    }
    return () => {
      stopped = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [enabled, projectRoot, revision]);

  return { enabled, changeEnabled, status, setStatus, requestReindex };
}
