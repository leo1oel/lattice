import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ProjectSnapshot } from "../app-types";
import { executeAgentBibliographyToolRequest, parseAgentBibliographyToolRequest } from "../agent/agent-bibliography-tools";
import { executeAgentCanvasToolRequest, parseAgentCanvasToolRequest } from "../agent/agent-canvas-tools";
import type { BuildAgentCommentsOptions } from "../agent/agent-editor-comments";
import {
  LATTICE_HOST_CONTEXT, LATTICE_HOST_CONTEXT_REQUEST, LATTICE_HOST_CONTEXT_SELECTION_CLEAR, type AgentHostContextSnapshot,
} from "../agent/agent-host-context";
import { LATTICE_HOST_THEME_REQUEST, readAgentHostTheme, type AgentHostThemeSnapshot } from "../agent/agent-host-theme";
import { LATTICE_PAPER_LIBRARY_REQUEST, type AgentPaperLibrarySnapshot } from "../agent/agent-paper-library";
import {
  executeAgentProjectDocumentToolRequest, parseAgentProjectDocumentToolRequest, type AgentProjectDocumentToolRequest,
} from "../agent/agent-project-document-tools";
import { executeAgentPresentationToolRequest, parseAgentPresentationToolRequest } from "../agent/agent-presentation-tools";
import { executeAgentSpreadsheetToolRequest, parseAgentSpreadsheetToolRequest } from "../agent/agent-spreadsheet-tools";
import { useSynaraConfirmationBridge } from "../agent/synara-confirmations";
import { useSynaraNotificationBridge } from "../agent/synara-notifications";
import { parseAgentProjectHistorySnapshot, synaraProjectRelativeFilePath } from "../agent/synara-runtime";
import { useSynaraRuntime } from "../agent/use-synara-runtime";
import { isSynaraPermissionMode, type SynaraPermissionMode } from "./app-synara-embed";
import { useLatestRef } from "../hooks/use-latest-ref";

const LATTICE_AGENT_PERMISSION_MODE_REQUEST = "lattice:request-agent-permission-mode";
const LATTICE_AGENT_PERMISSION_MODE_SET = "lattice:set-agent-permission-mode";
const LATTICE_AGENT_PANEL_OPENED = "lattice:agent-panel-opened";
const LATTICE_HOST_POINTER = "lattice:host-pointer";
/**
 * Bounds for the width the agent's composer reports it needs (its controls
 * side by side, the send button inside the box). The ceiling only guards
 * against a malformed report.
 */
const SYNARA_MINIMUM_WIDTH_FLOOR = 180;
const SYNARA_MINIMUM_WIDTH_CEILING = 720;

// Keep import expressions outside the component: React Compiler cannot lower them.
function loadAgentEditorComments() {
  return import("../agent/agent-editor-comments");
}

/** What the embedded agent can reach in the host; read at message time. */
type SynaraHostBridge = {
  openProviderSettings: () => void;
  /** Open a project file the agent named, in the host's own surfaces. */
  openProjectPath: (path: string) => void;
  /** Open source control, pinned to one turn's checkpoint diff when given. */
  openReview: (turn: { threadId: string; turnId: string } | null) => void;
  clearSelection: () => void;
  flushVisualMarkdown: () => void;
  agentCommentsOptions: () => BuildAgentCommentsOptions | null;
  projectDocumentCreator: () => ((request: AgentProjectDocumentToolRequest) => Promise<string>) | null;
  onHistorySnapshot: (snapshot: NonNullable<ReturnType<typeof parseAgentProjectHistorySnapshot>>) => void;
  /** The narrowest the agent frame can be with its composer intact, in CSS px. */
  onMinimumWidth: (width: number) => void;
};

type MessageData = Record<string, unknown> & { type?: unknown };

/** Tool calls the agent makes against host documents: parse, run, and answer. */
const TOOL_ROUTES: Array<(data: unknown, bridge: SynaraHostBridge, projectRoot: string | null) => Promise<object> | null> = [
  (data, _bridge, projectRoot) => {
    const request = parseAgentBibliographyToolRequest(data);
    return request && executeAgentBibliographyToolRequest(request, projectRoot);
  },
  (data, bridge) => {
    const request = parseAgentProjectDocumentToolRequest(data);
    return request && executeAgentProjectDocumentToolRequest(request, bridge.projectDocumentCreator());
  },
  (data) => {
    const request = parseAgentCanvasToolRequest(data);
    return request && executeAgentCanvasToolRequest(request);
  },
  (data) => {
    const request = parseAgentSpreadsheetToolRequest(data);
    return request && executeAgentSpreadsheetToolRequest(request);
  },
  (data, _bridge, projectRoot) => {
    const request = parseAgentPresentationToolRequest(data);
    return request && executeAgentPresentationToolRequest(request, projectRoot);
  },
];

const stringField = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The embedded Synara agent: its runtime, its iframes (the agent panel and
 * source control), the host context and paper library it reads, and the
 * message protocol it speaks with the host.
 */
export function useSynaraHost({ project, projectRef, agentVisible, bridge, appearance }: {
  project: ProjectSnapshot | null;
  projectRef: { readonly current: ProjectSnapshot | null };
  agentVisible: boolean;
  bridge: SynaraHostBridge;
  /** What the agent's host-theme snapshot is read from (agent-host-theme.ts). */
  appearance: Parameters<typeof readAgentHostTheme>[0];
}) {
  // One-way by design. A hidden Synara surface may still own a background turn
  // or PTY, so the first request starts the service for the rest of this app
  // process; process-idle shutdown needs an explicit lease/task protocol.
  const { t } = useLingui();
  const [runtimeRequested, setRuntimeRequested] = useState(false);
  const { runtime, retry } = useSynaraRuntime(runtimeRequested);
  const origin = runtime.state === "ready" ? runtime.origin : null;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sourceControlFrameRef = useRef<HTMLIFrameElement>(null);
  useSynaraNotificationBridge({ frameRef, origin, source: t`Synara agent` });
  useSynaraConfirmationBridge({ frameRef, origin });
  useSynaraNotificationBridge({ frameRef: sourceControlFrameRef, origin, source: t`Synara source control` });
  useSynaraConfirmationBridge({ frameRef: sourceControlFrameRef, origin });
  const [frameMounted, setFrameMounted] = useState(false);
  const [readyFrameKey, setReadyFrameKey] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<SynaraPermissionMode>("full-access");
  const [autoModeAvailable, setAutoModeAvailable] = useState(true);
  const frameKey = origin && project ? `${origin}\0${project.root}` : null;
  const frameReady = frameKey !== null && readyFrameKey === frameKey;
  const projectRootRef = useLatestRef(project?.root ?? null);
  const latest = useRef({
    bridge,
    agentVisible,
    frameKey,
    hostContext: null as AgentHostContextSnapshot | null,
    paperLibrary: null as AgentPaperLibrarySnapshot | null,
    hostTheme: null as AgentHostThemeSnapshot | null,
  });
  useLayoutEffect(() => {
    Object.assign(latest.current, { bridge, agentVisible, frameKey });
  });

  /** Start the runtime and mount the agent frame (both stay up once started). */
  const mountFrame = useCallback(() => {
    setRuntimeRequested(true);
    setFrameMounted(true);
  }, []);
  useEffect(() => {
    if (!project || !agentVisible) return;
    // Keep the cross-origin iframe out of the initial WebKit root render,
    // without requiring a click to restore the user's last workspace.
    const frame = window.requestAnimationFrame(mountFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [agentVisible, mountFrame, project]);

  const postMessage = useCallback(async (message: object) => {
    if (!origin) return;
    if ("type" in message && message.type === LATTICE_HOST_CONTEXT && !("editorComments" in message)) {
      const context = message as AgentHostContextSnapshot;
      const options = latest.current.bridge.agentCommentsOptions();
      if (options?.workspaceRoot === context.workspaceRoot) {
        const { buildAgentCommentsSnapshot } = await loadAgentEditorComments();
        if (projectRootRef.current !== context.workspaceRoot) return;
        message = {
          ...context,
          editorComments: buildAgentCommentsSnapshot({
            ...options, path: context.paper?.path ?? context.editor?.path, limit: 10,
          }),
        };
      }
    }
    frameRef.current?.contentWindow?.postMessage(message, origin);
  }, [origin, projectRootRef]);
  const notifyPanelOpened = useCallback(() => {
    if (frameReady) void postMessage({ type: LATTICE_AGENT_PANEL_OPENED });
  }, [frameReady, postMessage]);
  const changePermissionMode = useCallback((mode: SynaraPermissionMode) => {
    void postMessage({ type: LATTICE_AGENT_PERMISSION_MODE_SET, mode });
  }, [postMessage]);
  /** Point a mounted agent frame at `threadId`; an unmounted one opens on the persisted thread instead. */
  const showThread = useCallback((threadId: string) => {
    const frame = frameRef.current;
    if (!frame || !origin) return;
    const url = new URL(frame.src);
    url.pathname = `/${encodeURIComponent(threadId)}`;
    frame.src = url.toString();
  }, [origin]);

  // WebKit drops pointerleave when the cursor leaves the agent iframe, so hover
  // states inside it stick. Any pointerover here means the pointer is not over
  // the iframe: relay it, throttled, as the missing leave signal.
  useEffect(() => {
    if (!origin) return;
    let lastPost = 0;
    const notify = () => {
      const now = performance.now();
      if (now - lastPost < 150) return;
      lastPost = now;
      void postMessage({ type: LATTICE_HOST_POINTER });
    };
    document.addEventListener("pointerover", notify, true);
    return () => document.removeEventListener("pointerover", notify, true);
  }, [origin, postMessage]);
  useEffect(() => {
    if (!origin) return;
    const post = (message: object) => void postMessage(message);
    // A file the agent named opens in the host's own surfaces (cached Paper
    // markdown goes through the reader, like links inside our own preview).
    const openNamedFile = (data: MessageData, host: typeof latest.current) => {
      const path = synaraProjectRelativeFilePath(data.filePath, projectRef.current?.root);
      if (path) host.bridge.openProjectPath(path);
      return Boolean(path);
    };
    /** Messages identified by their `type`. */
    const handlers: Record<string, (data: MessageData, host: typeof latest.current) => void> = {
      "synara:embed-ready": (_data, host) => {
        if (host.frameKey) setReadyFrameKey(host.frameKey);
        post({ type: LATTICE_AGENT_PERMISSION_MODE_REQUEST });
        if (host.hostContext) post(host.hostContext);
        if (host.paperLibrary) post(host.paperLibrary);
        if (host.hostTheme) post(host.hostTheme);
        if (host.agentVisible) post({ type: LATTICE_AGENT_PANEL_OPENED });
      },
      "synara:open-settings": (data, host) => {
        if (data.section !== "providers") return;
        setRuntimeRequested(true);
        host.bridge.openProviderSettings();
      },
      "synara:open-file": openNamedFile,
      "synara:open-external": (data) => {
        // WebKit does not hand an embedded frame's `_blank` navigation to the system browser.
        const url = stringField(data.url);
        if (/^https?:\/\//i.test(url)) void openUrl(url).catch(() => undefined);
      },
      "synara:open-review": (data, host) => {
        // A file row opens in the host's file surface; the bare Review button
        // opens the drawer pinned to that turn's checkpoint diff, since the
        // working tree may already be clean.
        if (openNamedFile(data, host)) return;
        const threadId = stringField(data.threadId);
        const turnId = stringField(data.turnId);
        host.bridge.openReview(threadId && turnId ? { threadId, turnId } : null);
      },
      [LATTICE_HOST_CONTEXT_REQUEST]: (data, host) => {
        const context = host.hostContext;
        if (!context) return;
        const { requestId, workspaceRoot, refreshComments } = data;
        if (refreshComments !== true) {
          post(context);
          return;
        }
        if (typeof requestId !== "string" || requestId.length > 128 || workspaceRoot !== context.workspaceRoot) return;
        host.bridge.flushVisualMarkdown();
        const options = host.bridge.agentCommentsOptions();
        if (!options || options.workspaceRoot !== workspaceRoot) return;
        void loadAgentEditorComments().then(({ readAgentCommentsSnapshot }) => readAgentCommentsSnapshot({
          ...options, path: context.paper?.path ?? context.editor?.path, limit: 10,
        })).then((editorComments) => {
          // Never publish a previous project's comments after navigation.
          if (projectRootRef.current !== workspaceRoot || latest.current.hostContext?.workspaceRoot !== workspaceRoot) return;
          post({ ...context, requestId, editorComments });
        });
      },
      [LATTICE_PAPER_LIBRARY_REQUEST]: (_data, host) => {
        if (host.paperLibrary) post(host.paperLibrary);
      },
      [LATTICE_HOST_THEME_REQUEST]: (_data, host) => {
        if (host.hostTheme) post(host.hostTheme);
      },
      [LATTICE_HOST_CONTEXT_SELECTION_CLEAR]: (_data, host) => host.bridge.clearSelection(),
      "synara:editor-comments-tool-request": (data, host) => {
        void loadAgentEditorComments().then(async (tools) => {
          const request = tools.parseAgentEditorCommentsToolRequest(data);
          if (!request) return;
          await postMessage(await tools.executeAgentEditorCommentsToolRequest(
            request,
            () => projectRootRef.current,
            async (commentsRequest) => {
              host.bridge.flushVisualMarkdown();
              const options = host.bridge.agentCommentsOptions();
              if (!options) throw new Error("editor_comments_host_unavailable");
              return tools.readAgentCommentsSnapshot({ ...options, ...commentsRequest.args });
            },
          ));
        });
      },
      "synara:agent-permission-mode": (data) => {
        if (!isSynaraPermissionMode(data.mode)) return;
        setPermissionMode(data.mode);
        setAutoModeAvailable(data.autoModeAvailable !== false);
      },
      // The composer measures its own controls (latticeComposerLayout.ts in
      // Synara) and reports the frame width that keeps them, and the send
      // button, inside the box. An intrinsic width, so it may also decrease.
      "synara:layout-metrics": (data, host) => {
        const width = data.minimumSidebarWidth;
        if (typeof width !== "number" || !Number.isFinite(width)) return;
        host.bridge.onMinimumWidth(Math.round(
          Math.min(SYNARA_MINIMUM_WIDTH_CEILING, Math.max(SYNARA_MINIMUM_WIDTH_FLOOR, width)),
        ));
      },
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== origin) return;
      const data = event.data as MessageData | null;
      const host = latest.current;
      const handler = typeof data?.type === "string" ? handlers[data.type] : undefined;
      if (data && handler) {
        handler(data, host);
        return;
      }
      for (const route of TOOL_ROUTES) {
        const response = route(data, host.bridge, projectRootRef.current);
        if (response) {
          void response.then(post);
          return;
        }
      }
      const historySnapshot = parseAgentProjectHistorySnapshot(data);
      if (historySnapshot) host.bridge.onHistorySnapshot(historySnapshot);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [origin, postMessage, projectRef, projectRootRef]);

  // The theme travels over the bridge rather than the frame URL, so a tint or
  // an accent dragged in the color picker repaints the agent without
  // reloading it. A frame that reloads (light/dark is still in its URL) gets
  // the snapshot again from its own embed-ready.
  const { theme, tint, accent, translucency, translucent } = appearance;
  useEffect(() => {
    const snapshot = readAgentHostTheme({ theme, tint, accent, translucency, translucent });
    latest.current.hostTheme = snapshot;
    if (frameReady) void postMessage(snapshot);
  }, [theme, tint, accent, translucency, translucent, frameReady, postMessage]);

  const requestRuntime = useCallback(() => setRuntimeRequested(true), []);
  return {
    runtime, retry, origin, requestRuntime, mountFrame,
    frameRef, sourceControlFrameRef, frameMounted, frameReady,
    permissionMode, autoModeAvailable, changePermissionMode,
    postMessage, notifyPanelOpened, showThread,
    /** Delivery state for the snapshots useAgentContext posts; not for rendering. */
    latest,
    deliverable: Boolean(origin && frameMounted && frameReady && agentVisible),
  };
}

export type SynaraHost = ReturnType<typeof useSynaraHost>;
