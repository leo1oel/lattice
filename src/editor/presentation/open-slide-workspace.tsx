import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { deckIdFromOpenSlidePath, toMessage } from "../../app-utils";
import { i18n } from "../../i18n";
import type { OpenSlideFileViewState } from "../../app-types";
import {
  browserRuntimeDetached,
  subscribeBrowserRuntimeDetached,
} from "../../platform/browser-runtime";
import type { AppLocale, Theme } from "../../settings/app-settings";
import {
  advanceOpenSlideEventCursor,
  consumeOpenSlideEvents,
  openSlideEventCursor,
  type OpenSlideContext,
  type OpenSlideMutation,
  type OpenSlideSyncOperation,
} from "./open-slide-bridge";
import "./open-slide-workspace.css";

/** The parts of the `presentation_ensure_ready` payload this view reads. */
type PresentationRuntimeInfo = {
  origin: string | null;
  sessionUrl: string | null;
  controlToken: string | null;
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

function revertMutation({ path, kind, previousText, previousBase64 }: OpenSlideMutation): OpenSlideSyncOperation[] {
  if (previousText !== undefined) return [{ path, kind: "write", text: previousText }];
  if (previousBase64 !== undefined) return [{ path, kind: "write", base64: previousBase64 }];
  return kind === "create" ? [{ path, kind: "delete" }] : [];
}

// Bridge routes and headers are loopback protocol constants, not interface
// copy. Their errors reach the user as an error notice.
async function controlFetch(info: PresentationRuntimeInfo, endpoint: string, init: RequestInit & { headers?: Record<string, string> }) {
  if (!info.origin || !info.controlToken) throw new Error(i18n._(msg`Open Slide is not ready`));
  /* eslint-disable lingui/no-unlocalized-strings -- loopback bridge route and headers */
  return fetch(`${info.origin}/__lattice/${endpoint}`, {
    ...init,
    headers: { authorization: `Bearer ${info.controlToken}`, ...init.headers },
  });
}

async function postControl(info: PresentationRuntimeInfo, endpoint: "access" | "sync", body: unknown, signal?: AbortSignal) {
  const response = await controlFetch(info, endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  /* eslint-enable lingui/no-unlocalized-strings */
  const status = response.status;
  if (!response.ok) throw new Error(await response.text() || i18n._(msg`Open Slide bridge returned ${status}`));
}

/** Push the canonical editor bytes for `path` into Open Slide's shadow copy. */
function syncSource(info: PresentationRuntimeInfo, path: string, text: string, signal: AbortSignal) {
  return postControl(info, "sync", { operations: [{ path, kind: "write", text }] }, signal);
}

/** Report a failure unless it is the abort that tore its effect down. */
function reportUnlessAborted(signal: AbortSignal, latest: { current: { onError?: (message: string) => void } }) {
  return (reason: unknown) => {
    if (!signal.aborted) latest.current.onError?.(toMessage(reason));
  };
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
  // Keyed by project so a switch never shows the previous project's runtime.
  const [startup, setStartup] = useState<{
    projectRoot: string;
    info?: PresentationRuntimeInfo;
    error?: string;
  } | null>(null);
  const runtime = startup?.projectRoot === projectRoot ? startup.info ?? null : null;
  const startupError = startup?.projectRoot === projectRoot ? startup.error ?? null : null;
  // The parent keys this workspace by file. Freeze the restored page for this
  // iframe lifetime so reporting a later page does not itself change `src`
  // and reload the deck that just reported it.
  const [restoredPage] = useState(() => Math.max(1, Math.floor(initialViewState?.page ?? 1)));
  const reportedPageRef = useRef(restoredPage);
  const latestContextRef = useRef<OpenSlideContext | null>(null);
  const mutationInFlightRef = useRef(0);
  const requestNativeRefreshRef = useRef<() => void>(() => undefined);
  // App rebuilds these callbacks whenever the project or file tree refreshes.
  // No effect below may depend on their identity: re-running the event
  // effect aborted the stream about once a second, and each gap dropped the
  // Open Slide saves broadcast inside it; re-running the sync effects pushed
  // the old project source back over those saves.
  const latest = useRef({ source, active, onMutation, onContext, onError, onViewState });
  useEffect(() => {
    latest.current = { source, active, onMutation, onContext, onError, onViewState };
  });
  useEffect(() => {
    // The event cursor is shared by every deck on this page, so a deck that
    // becomes active resumes after whatever the previously active deck
    // applied rather than replaying it.
    if (active && latestContextRef.current) latest.current.onContext?.(latestContextRef.current);
  }, [active]);
  useEffect(() => () => {
    if (latest.current.active) latest.current.onContext?.(null);
  }, []);
  // Once this page is displaced, its iframe would keep accepting saves into
  // the runtime while nothing here can apply them to the project. Drop the
  // iframe and every host bridge loop instead.
  const detached = useSyncExternalStore(subscribeBrowserRuntimeDetached, browserRuntimeDetached);

  useEffect(() => {
    let disposed = false;
    let leaseId: string | null = null;
    void invoke<PresentationRuntimeInfo>("presentation_ensure_ready", { projectRoot })
      .then((info) => {
        leaseId = info.leaseId;
        if (!disposed) setStartup({ projectRoot, info });
        else if (leaseId) void invoke("presentation_release", { projectRoot, leaseId });
      })
      .catch((reason) => {
        if (!disposed) setStartup({ projectRoot, error: toMessage(reason) });
      });
    return () => {
      disposed = true;
      if (leaseId) void invoke("presentation_release", { projectRoot, leaseId });
    };
  }, [projectRoot]);

  useEffect(() => {
    if (!runtime?.leaseId) return;
    const controller = new AbortController();
    // A displaced page cannot reach the native host to release its lease, but
    // the runtime is loopback HTTP. Withdraw the lease directly so that, with
    // no live page holding one, the runtime refuses saves outright.
    void postControl(runtime, "access", detached
      ? { leaseId: runtime.leaseId, remove: true }
      : { leaseId: runtime.leaseId, writable: editable }, controller.signal)
      .catch((reason) => {
        if (!detached) reportUnlessAborted(controller.signal, latest)(reason);
      });
    return () => controller.abort();
  }, [detached, editable, runtime]);

  useEffect(() => {
    if (!runtime || detached) return;
    if (latestContextRef.current?.pendingEdits || mutationInFlightRef.current > 0) {
      // The queued native refresh will send the latest canonical source after
      // the inspector draft has become a real file mutation. Sending this prop
      // immediately is the other path by which an Overleaf pull could replace
      // the shadow source underneath an unsaved inspector edit.
      return;
    }
    const controller = new AbortController();
    void syncSource(runtime, path, source, controller.signal).catch(reportUnlessAborted(controller.signal, latest));
    return () => controller.abort();
  }, [detached, path, runtime, source]);

  useEffect(() => {
    if (!active || !runtime || detached) return;
    const controller = new AbortController();
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
      // Inspector changes are optimistic until Open Slide emits its saved
      // file mutation. Pulling Overleaf or another disk writer into the
      // shadow now would remount the slide on the old text and invalidate
      // the text candidate that the pending edit uses when it is committed.
      if (latestContextRef.current?.pendingEdits || mutationInFlightRef.current > 0 || refreshing) {
        refreshQueued = true;
        return;
      }
      refreshQueued = false;
      refreshing = true;
      try {
        await invoke("presentation_refresh_native_workspace", { projectRoot });
        if (controller.signal.aborted) return;
        // The filesystem refresh includes the active entry, whose disk mirror
        // can lag its Yjs document briefly. Reassert the canonical editor bytes
        // last so a peer edit can never be replaced by that stale mirror.
        await syncSource(runtime, path, latest.current.source, controller.signal);
      } catch (reason) {
        reportUnlessAborted(controller.signal, latest)(reason);
      } finally {
        refreshing = false;
        if (refreshQueued) {
          refreshQueued = false;
          scheduleRefresh();
        }
      }
    };
    requestNativeRefreshRef.current = scheduleRefresh;
    // Native project writes already flow through the filesystem watcher. A
    // two-second poll previously rehashed every slide and asset forever,
    // contending with the WebView and Vite while a deck was open.
    void invoke("watch_project").catch(() => undefined);
    void listen<{ root: string }>("project-fs-changed", (event) => {
      if (event.payload.root === projectRoot) scheduleRefresh();
    }).then((dispose) => {
      if (controller.signal.aborted) dispose();
      else unlisten = dispose;
    });
    void refresh();
    return () => {
      controller.abort();
      unlisten?.();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      requestNativeRefreshRef.current = () => undefined;
    };
  }, [active, detached, path, projectRoot, runtime]);

  useEffect(() => {
    if (!active || detached || !runtime?.origin || !runtime.controlToken) return;
    const { origin, controlToken } = runtime;
    const controller = new AbortController();
    const receive = async () => {
      while (!controller.signal.aborted) {
        try {
          const cursor = openSlideEventCursor(origin, controlToken);
          const response = await controlFetch(runtime, "events", {
            // Send the cursor even when it is 0: that still asks the runtime
            // to replay whatever was broadcast while this page had no stream
            // open. Only a page that never attached omits it.
            headers: cursor !== undefined ? { "last-event-id": String(cursor) } : {},
            signal: controller.signal,
          });
          // Preserve the HTTP status in diagnostic detail for support logs.
          const status = response.status;
          if (!response.ok || !response.body) throw new Error(i18n._(msg`Open Slide event bridge returned ${status}`));
          await consumeOpenSlideEvents(response.body, async (event) => {
            if ("type" in event && event.type === "ready") {
              advanceOpenSlideEventCursor(origin, controlToken, event);
              return;
            }
            if ("context" in event) {
              advanceOpenSlideEventCursor(origin, controlToken, event);
              if (event.context.pagePath !== path) return;
              const refreshWasBlocked = latestContextRef.current?.pendingEdits === true;
              latestContextRef.current = event.context;
              if (refreshWasBlocked && !event.context.pendingEdits) {
                requestNativeRefreshRef.current();
              }
              if (event.context.pageNumber !== reportedPageRef.current) {
                reportedPageRef.current = event.context.pageNumber;
                latest.current.onViewState?.({ page: event.context.pageNumber });
              }
              latest.current.onContext?.(event.context);
              return;
            }
            mutationInFlightRef.current += 1;
            try {
              const operations = await latest.current.onMutation(event).catch((reason: unknown) => {
                latest.current.onError?.(toMessage(reason));
                return revertMutation(event);
              });
              if (operations.length) await postControl(runtime, "sync", { operations }, controller.signal);
              // Advance only once the host has the edit. An abort before this
              // point leaves the mutation for the next stream to replay.
              advanceOpenSlideEventCursor(origin, controlToken, event);
            } finally {
              mutationInFlightRef.current -= 1;
              requestNativeRefreshRef.current();
            }
          });
        } catch (reason) {
          if (controller.signal.aborted) return;
          latest.current.onError?.(toMessage(reason));
          await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        }
      }
    };
    void receive();
    return () => controller.abort();
  }, [active, detached, path, runtime]);

  const status = (role: "alert" | "status", children: ReactNode) => (
    <div className="open-slide-status" role={role} data-tour="open-slide-workspace">{children}</div>
  );
  if (!deckId) return status("alert", t`This is not a native Open Slide deck.`);
  if (startupError) {
    return status("alert", <>
      <strong>{t`Open Slide could not start`}</strong>
      <span>{startupError}</span>
    </>);
  }
  if (detached) {
    // The runtime failure overlay covers the page and explains why. Keeping
    // only the frame's container avoids leaving a focused editor behind it.
    return <div className="open-slide-workspace" data-tour="open-slide-workspace" />;
  }
  if (!runtime?.sessionUrl) return status("status", t`Starting Open Slide…`);
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
