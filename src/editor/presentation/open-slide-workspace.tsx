import { useEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { deckIdFromOpenSlidePath } from "../../app-utils";
import type { OpenSlideFileViewState } from "../../app-types";
import type { AppLocale, Theme } from "../../settings/app-settings";
import {
  consumeOpenSlideEvents,
  type OpenSlideContext,
  type OpenSlideMutation,
  type OpenSlideSyncOperation,
} from "./open-slide-bridge";
import "./open-slide-workspace.css";

type PresentationRuntimeInfo = {
  state: "ready" | "stopped";
  origin: string | null;
  sessionUrl: string | null;
  controlToken: string | null;
  version: string;
  projectRoot: string | null;
  leases: number;
  leaseId: string | null;
};

export type OpenSlideWorkspaceProps = {
  projectRoot: string;
  path: string;
  source: string;
  editable: boolean;
  locale: AppLocale;
  theme: Theme;
  active?: boolean;
  onMutation: (mutation: OpenSlideMutation) => Promise<OpenSlideSyncOperation[]>;
  onContext?: (context: OpenSlideContext | null) => void;
  onError?: (message: string) => void;
  initialViewState?: OpenSlideFileViewState;
  onViewState?: (state: OpenSlideFileViewState) => void;
};

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function revertMutation(mutation: OpenSlideMutation): OpenSlideSyncOperation[] {
  if (mutation.previousText !== undefined) {
    return [{ path: mutation.path, kind: "write", text: mutation.previousText }];
  }
  if (mutation.previousBase64 !== undefined) {
    return [{ path: mutation.path, kind: "write", base64: mutation.previousBase64 }];
  }
  return mutation.kind === "create"
    ? [{ path: mutation.path, kind: "delete" }]
    : [];
}

async function postControl(
  info: PresentationRuntimeInfo,
  endpoint: "access" | "sync",
  body: unknown,
  signal?: AbortSignal,
) {
  // These strings are loopback protocol constants and raw transport errors,
  // not interface copy. Callers surface them as diagnostic detail.
  /* eslint-disable lingui/no-unlocalized-strings */
  if (!info.origin || !info.controlToken) throw new Error("Open Slide is not ready");
  const response = await fetch(`${info.origin}/__lattice/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${info.controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(await response.text() || `Open Slide bridge returned ${response.status}`);
  /* eslint-enable lingui/no-unlocalized-strings */
}

export function OpenSlideWorkspace({
  projectRoot,
  path,
  source,
  editable,
  locale,
  theme,
  active = true,
  onMutation,
  onContext,
  onError,
  initialViewState,
  onViewState,
}: OpenSlideWorkspaceProps) {
  const { t } = useLingui();
  const deckId = useMemo(() => deckIdFromOpenSlidePath(path), [path]);
  const [runtimeState, setRuntime] = useState<{
    projectRoot: string;
    info: PresentationRuntimeInfo;
  } | null>(null);
  const [startupErrorState, setStartupError] = useState<{
    projectRoot: string;
    message: string;
  } | null>(null);
  const runtime = runtimeState?.projectRoot === projectRoot ? runtimeState.info : null;
  const startupError = startupErrorState?.projectRoot === projectRoot
    ? startupErrorState.message
    : null;
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);
  // The parent keys this workspace by file. Freeze the restored page for this
  // iframe lifetime so reporting a later page does not itself change `src`
  // and reload the deck that just reported it.
  const [restoredPage] = useState(() => Math.max(1, Math.floor(initialViewState?.page ?? 1)));
  const reportedPageRef = useRef(restoredPage);
  const onViewStateRef = useRef(onViewState);
  useEffect(() => {
    onViewStateRef.current = onViewState;
  }, [onViewState]);

  useEffect(() => {
    let disposed = false;
    let leaseId: string | null = null;
    void invoke<PresentationRuntimeInfo>("presentation_ensure_ready", { projectRoot })
      .then((info) => {
        leaseId = info.leaseId;
        if (!disposed) setRuntime({ projectRoot, info });
        else if (leaseId) void invoke("presentation_release", { projectRoot, leaseId });
      })
      .catch((reason) => {
        if (!disposed) setStartupError({ projectRoot, message: errorMessage(reason) });
      });
    return () => {
      disposed = true;
      if (leaseId) void invoke("presentation_release", { projectRoot, leaseId });
    };
  }, [projectRoot]);

  useEffect(() => {
    if (!runtime) return;
    const controller = new AbortController();
    if (!runtime.leaseId) return;
    void postControl(runtime, "access", {
      leaseId: runtime.leaseId,
      writable: editable,
    }, controller.signal)
      .catch((reason) => {
        if (!controller.signal.aborted) onError?.(errorMessage(reason));
      });
    return () => controller.abort();
  }, [editable, onError, runtime]);

  useEffect(() => {
    if (!runtime) return;
    const controller = new AbortController();
    void postControl(runtime, "sync", {
      operations: [{ path, kind: "write", text: source }],
    }, controller.signal).catch((reason) => {
      if (!controller.signal.aborted) onError?.(errorMessage(reason));
    });
    return () => controller.abort();
  }, [onError, path, runtime, source]);

  useEffect(() => {
    if (!active || !runtime) return;
    const controller = new AbortController();
    let disposed = false;
    let refreshing = false;
    let refreshQueued = false;
    let refreshTimer: number | null = null;
    let unlisten: (() => void) | null = null;
    const scheduleRefresh = () => {
      if (controller.signal.aborted) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, 300);
    };
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        await invoke("presentation_refresh_native_workspace", { projectRoot });
        if (controller.signal.aborted) return;
        // The filesystem refresh includes the active entry, whose disk mirror
        // can lag its Yjs document briefly. Reassert the canonical editor bytes
        // last so a peer edit can never be replaced by that stale mirror.
        await postControl(runtime, "sync", {
          operations: [{ path, kind: "write", text: sourceRef.current }],
        }, controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted) onError?.(errorMessage(reason));
      } finally {
        refreshing = false;
        if (refreshQueued) {
          refreshQueued = false;
          scheduleRefresh();
        }
      }
    };
    // Native project writes already flow through the filesystem watcher. A
    // two-second poll previously rehashed every slide and asset forever,
    // contending with the WebView and Vite while a deck was open.
    void invoke("watch_project").catch(() => undefined);
    void listen<{ root: string }>("project-fs-changed", (event) => {
      if (!disposed && event.payload.root === projectRoot) scheduleRefresh();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      unlisten?.();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [active, onError, path, projectRoot, runtime]);

  useEffect(() => {
    if (!active || !runtime?.origin || !runtime.controlToken) return;
    const controller = new AbortController();
    let lastEventId = 0;
    const receive = async () => {
      while (!controller.signal.aborted) {
        try {
          // Loopback bridge route and headers are protocol constants.
          // eslint-disable-next-line lingui/no-unlocalized-strings
          const response = await fetch(`${runtime.origin}/__lattice/events`, {
            headers: {
              // eslint-disable-next-line lingui/no-unlocalized-strings
              authorization: `Bearer ${runtime.controlToken}`,
              ...(lastEventId ? { "last-event-id": String(lastEventId) } : {}),
            },
            signal: controller.signal,
          });
          // Preserve the HTTP status in diagnostic detail for support logs.
          // eslint-disable-next-line lingui/no-unlocalized-strings
          if (!response.ok || !response.body) throw new Error(`Open Slide event bridge returned ${response.status}`);
          await consumeOpenSlideEvents(response.body, async (event) => {
            if ("context" in event) {
              if (
                event.context.pagePath === path
                && event.context.pageNumber !== reportedPageRef.current
              ) {
                reportedPageRef.current = event.context.pageNumber;
                onViewStateRef.current?.({ page: event.context.pageNumber });
              }
              onContext?.(event.context);
              lastEventId = Math.max(lastEventId, event.id);
              return;
            }
            const mutation = event;
            let operations: OpenSlideSyncOperation[];
            try {
              operations = await onMutation(mutation);
            } catch (reason) {
              operations = revertMutation(mutation);
              onError?.(errorMessage(reason));
            }
            if (operations.length) await postControl(runtime, "sync", { operations }, controller.signal);
            lastEventId = Math.max(lastEventId, mutation.id);
          });
        } catch (reason) {
          if (controller.signal.aborted) return;
          onError?.(errorMessage(reason));
          await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        }
      }
    };
    void receive();
    return () => {
      controller.abort();
      onContext?.(null);
    };
  }, [active, onContext, onError, onMutation, path, runtime]);

  if (!deckId) {
    return <div className="open-slide-status" role="alert" data-tour="open-slide-workspace">{t`This is not a native Open Slide deck.`}</div>;
  }
  if (startupError) {
    return (
      <div className="open-slide-status" role="alert" data-tour="open-slide-workspace">
        <strong>{t`Open Slide could not start`}</strong>
        <span>{startupError}</span>
      </div>
    );
  }
  if (!runtime?.sessionUrl) {
    return <div className="open-slide-status" role="status" data-tour="open-slide-workspace">{t`Starting Open Slide…`}</div>;
  }
  // Open Slide owns this application route.
  // eslint-disable-next-line lingui/no-unlocalized-strings
  const next = `/s/${encodeURIComponent(deckId)}${restoredPage > 1 ? `?p=${restoredPage}` : ""}`;
  const separator = runtime.sessionUrl.includes("?") ? "&" : "?";
  return (
    <div className="open-slide-workspace" data-tour="open-slide-workspace">
      <iframe
        className="open-slide-frame"
        src={`${runtime.sessionUrl}${separator}locale=${encodeURIComponent(locale)}&theme=${encodeURIComponent(theme)}&next=${encodeURIComponent(next)}`}
        title={t({ message: `Open Slide editor for ${deckId}` })}
        allow="clipboard-write; fullscreen"
        allowFullScreen
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-presentation"
      />
    </div>
  );
}

export default OpenSlideWorkspace;
