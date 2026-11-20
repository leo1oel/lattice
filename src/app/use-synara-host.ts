import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ProjectSnapshot } from "../app-types";
import type { TrellisController } from "../trellis/trellis-controller";
import { executeAgentBibliographyToolRequest, parseAgentBibliographyToolRequest } from "../agent/agent-bibliography-tools";
import { executeAgentCanvasToolRequest, parseAgentCanvasToolRequest } from "../agent/agent-canvas-tools";
import {
  executeAgentAnnotationsToolRequest, parseAgentAnnotationsToolRequest, type AnnotationToolHost,
} from "../agent/agent-annotations";
import {
  SYNARA_COMPOSER_PROMPT_RESULT, parseAgentComposerPromptResult, type AgentComposerPromptMessage,
} from "../agent/agent-composer-prompt";
import type { BuildAgentCommentsOptions } from "../agent/agent-editor-comments";
import {
  LATTICE_HOST_CONTEXT, LATTICE_HOST_CONTEXT_REQUEST, LATTICE_HOST_CONTEXT_SELECTION_CLEAR, answerHostContextRefresh,
  type AgentHostContextSnapshot,
} from "../agent/agent-host-context";
import { LATTICE_HOST_THEME_REQUEST, readAgentHostTheme, type AgentHostThemeSnapshot } from "../agent/agent-host-theme";
import { LATTICE_PAPER_LIBRARY_REQUEST, type AgentPaperLibrarySnapshot } from "../agent/agent-paper-library";
import {
  executeAgentProjectDocumentToolRequest, parseAgentProjectDocumentToolRequest, rejectAgentProjectDocumentToolRequest, type AgentProjectDocumentToolRequest,
} from "../agent/agent-project-document-tools";
import { executeAgentFigureToolRequest, parseAgentFigureToolRequest } from "../agent/agent-figure-tools";
import { executeAgentPresentationToolRequest, parseAgentPresentationToolRequest } from "../agent/agent-presentation-tools";
import { executeAgentSpreadsheetToolRequest, parseAgentSpreadsheetToolRequest } from "../agent/agent-spreadsheet-tools";
import {
  SYNARA_TURN_ACTIVITY, contextDeck, nextAgentDeckPresence, parseAgentTurnActivity, publishAgentDeckPresence,
} from "../agent/agent-turn-activity";
import {
  SYNARA_EXPAND_VISUAL, SYNARA_SAVE_VISUAL, parseAgentVisualExpand, parseAgentVisualSave, saveAgentVisual,
  type AgentVisualExpand,
} from "../agent/agent-visual-save";
import { useSynaraConfirmationBridge } from "../agent/synara-confirmations";
import { useSynaraNotificationBridge } from "../agent/synara-notifications";
import { useSynaraPopupDismissalBridge } from "../agent/synara-popup-dismissal";
import { useSynaraHostShortcuts } from "../agent/synara-host-shortcuts";
import { parseAgentProjectHistorySnapshot, synaraProjectRelativeFilePath } from "../agent/synara-runtime";
import { receiveProjectAgentActivity } from "../agent/project-agent-activity";
import { useSynaraRuntime } from "../agent/use-synara-runtime";
import { markGetStartedStep } from "../onboarding/get-started-progress";
import { announceBibliographyWrite } from "../project/project-files-changed";
import { isSynaraPermissionMode, persistSynaraThread, type SynaraPermissionMode } from "./app-synara-embed";
import { useLatestRef } from "../hooks/use-latest-ref";
import { i18n } from "../i18n";
import { showError, showWarning } from "./notify";
import { setHostFileWritesSink } from "../agent/agent-host-writes";
import { useSynaraProjectFrames, type SynaraProjectFrame } from "./use-synara-project-frames";
import { runAgentTool, toolError } from "../agent/agent-protocol";

const LATTICE_AGENT_PERMISSION_MODE_REQUEST = "lattice:request-agent-permission-mode";
const LATTICE_AGENT_PERMISSION_MODE_SET = "lattice:set-agent-permission-mode";
const LATTICE_AGENT_PANEL_OPENED = "lattice:agent-panel-opened";
/**
 * `{ visible }`: whether the Agent panel is on screen. Its frame stays mounted
 * while the panel is behind another tab, collapsed or hidden, where the
 * frame's own visibilityState still says visible; only a panel shown here
 * keeps its thread's Claude out of the idle stop and starts one ahead of Send.
 */
const LATTICE_AGENT_PANEL_VISIBILITY = "lattice:agent-panel-visibility";
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
  /** `target` names a place on the Providers page to open (`SYNARA_SETTINGS_TARGETS`). */
  openProviderSettings: (target?: SynaraSettingsTarget) => void;
  /** Open a project file the agent named, in the host's own surfaces. */
  openProjectPath: (path: string) => void;
  /** Open source control, pinned to one turn's checkpoint diff when given. */
  openReview: (turn: { threadId: string; turnId: string } | null) => void;
  clearSelection: () => void;
  flushVisualMarkdown: () => void;
  agentCommentsOptions: () => BuildAgentCommentsOptions | null;
  /** Where the conversation's annotation tools record a proposal or question; null without a project. */
  annotationTools: () => AnnotationToolHost | null;
  projectDocumentCreator: () => ((request: AgentProjectDocumentToolRequest) => Promise<string>) | null;
  onHistorySnapshot: (snapshot: NonNullable<ReturnType<typeof parseAgentProjectHistorySnapshot>>) => void;
};

type MessageData = Record<string, unknown> & { type?: unknown };
type ToolRouteScope = {
  root: string;
  retained: () => string | null;
  active: () => string | null;
};

function backgroundToolError(request: { type: string; id: string }) {
  // All these routes use the same request/result envelope.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- wire message type
  const type = request.type.replace(/^synara:/, "lattice:").replace(/-request$/, "-result");
  return runAgentTool(type, request.id, "project_not_active", () => {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- error returned to the Agent model
    throw toolError("Select this project tab in Lattice before using this editor tool.", "project_not_active");
  });
}

/** Parse and answer tools within the frame's own workspace. */
const TOOL_ROUTES: Array<(
  data: unknown, bridge: SynaraHostBridge, scope: ToolRouteScope,
) => Promise<object> | null> = [
  (data, _bridge, scope) => {
    const request = parseAgentBibliographyToolRequest(data);
    if (!request) return null;
    const removal = request.action === "remove_reference";
    if (removal && !scope.active()) return backgroundToolError(request);
    return executeAgentBibliographyToolRequest(request, removal ? scope.active : scope.retained).then((response) => {
      if (response.ok && request.params.dryRun !== true && !removal) announceBibliographyWrite(request.workspaceRoot);
      return response;
    });
  },
  (data, bridge, scope) => {
    const request = parseAgentProjectDocumentToolRequest(data);
    if (!request) return rejectAgentProjectDocumentToolRequest(data);
    return scope.active()
      ? executeAgentProjectDocumentToolRequest(request, bridge.projectDocumentCreator())
      : backgroundToolError(request);
  },
  (data, _bridge, scope) => {
    const request = parseAgentCanvasToolRequest(data);
    return request && (scope.active() ? executeAgentCanvasToolRequest(request) : backgroundToolError(request));
  },
  (data, _bridge, scope) => {
    const request = parseAgentSpreadsheetToolRequest(data);
    return request && (scope.active() ? executeAgentSpreadsheetToolRequest(request, () => Boolean(scope.active())) : backgroundToolError(request));
  },
  (data, _bridge, scope) => {
    const request = parseAgentPresentationToolRequest(data);
    return request && (scope.active()
      ? executeAgentPresentationToolRequest(request, scope.root)
      : backgroundToolError(request));
  },
  (data, _bridge, scope) => {
    const request = parseAgentFigureToolRequest(data);
    return request && executeAgentFigureToolRequest(request, scope.root);
  },
];

const stringField = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The places on Synara's settings pages the agent panel may open Settings on: the
 * no-agent notice's "Set path…" opens Claude Code's and Codex's binary path fields.
 */
const SYNARA_SETTINGS_TARGETS = ["provider-binary-paths"] as const;
export type SynaraSettingsTarget = (typeof SYNARA_SETTINGS_TARGETS)[number];
const synaraSettingsTarget = (value: unknown): SynaraSettingsTarget | undefined =>
  SYNARA_SETTINGS_TARGETS.find((target) => target === value);

/**
 * The embedded Synara agent: its runtime, its iframes (the agent panel and
 * source control), the host context and paper library it reads, and the
 * message protocol it speaks with the host.
 */
export function useSynaraHost({ project, projectRef, agentVisible, bridge, appearance, openProject, trellis }: {
  project: ProjectSnapshot | null;
  projectRef: { readonly current: ProjectSnapshot | null };
  agentVisible: boolean;
  bridge: SynaraHostBridge;
  openProject?: (root: string) => Promise<boolean>;
  trellis?: Pick<TrellisController, "showPanel" | "ui">;
  /** What the agent's host-theme snapshot is read from (agent-host-theme.ts). */
  appearance: Parameters<typeof readAgentHostTheme>[0];
}) {
  // One-way by design. A hidden Synara surface may still own a background turn
  // or PTY, so the first request starts the service for the rest of this app
  // process; process-idle shutdown needs an explicit lease/task protocol.
  const { t } = useLingui();
  const [runtimeRequested, setRuntimeRequested] = useState(false);
  const { runtime, retry } = useSynaraRuntime(runtimeRequested, project?.root ?? null);
  const origin = runtime.state === "ready" ? runtime.origin : null;
  const serviceIdentity = origin ? `${origin}\0${runtime.authToken ?? ""}` : null;
  const sourceControlFrameRef = useRef<HTMLIFrameElement>(null);
  useSynaraNotificationBridge({ frameRef: sourceControlFrameRef, origin, source: t`Synara source control` });
  useSynaraConfirmationBridge({ frameRef: sourceControlFrameRef, origin });
  useSynaraPopupDismissalBridge({ frameRef: sourceControlFrameRef, origin });
  useSynaraHostShortcuts(origin);
  const projectRoot = project?.root ?? null;
  const projectRootRef = useLatestRef(projectRoot);
  const {
    frames, framesRef, currentFrame, contextFor, mountProjectFrame, frameLoading, frameBecameReady,
    retryProjectFrame, scheduleRetirement, retainBackgroundProject,
  } = useSynaraProjectFrames(projectRoot, serviceIdentity);
  const frameMounted = currentFrame !== undefined;
  const frameReady = Boolean(origin && currentFrame?.ready);
  const [permissionMode, setPermissionMode] = useState<SynaraPermissionMode>("full-access");
  const [autoModeAvailable, setAutoModeAvailable] = useState(true);
  const [expandedVisual, setExpandedVisual] = useState<AgentVisualExpand | null>(null);
  const closeExpandedVisual = useCallback(() => setExpandedVisual(null), []);
  const latest = useLatestRef({ bridge, agentVisible, openProject });
  const hostTheme = useRef<AgentHostThemeSnapshot | null>(null);
  const isFrameProjectActive = useCallback((root: string) => projectRef.current?.root === root, [projectRef]);
  const selectFrameProject = useCallback(async (root: string) => {
    const opened = latest.current.openProject ? await latest.current.openProject(root) : isFrameProjectActive(root);
    if (opened) trellis?.showPanel("agent");
    return opened;
  }, [isFrameProjectActive, latest, trellis]);
  const mountFrame = useCallback(() => {
    const root = projectRootRef.current;
    if (!root) return;
    setRuntimeRequested(true);
    mountProjectFrame(root);
  }, [mountProjectFrame, projectRootRef]);
  useEffect(() => {
    if (!projectRoot || !agentVisible) return;
    // Keep the cross-origin iframe out of the initial WebKit root render.
    const frame = window.requestAnimationFrame(mountFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [agentVisible, mountFrame, projectRoot]);

  const setContextSnapshots = useCallback((
    hostContext: AgentHostContextSnapshot | null, paperLibrary: AgentPaperLibrarySnapshot | null,
  ) => {
    if (!hostContext || !paperLibrary) return;
    Object.assign(contextFor(hostContext.workspaceRoot), { hostContext, paperLibrary });
  }, [contextFor]);

  // Each reply belongs to the frame and document that sent its request, even
  // when another project becomes active while its host operation awaits I/O.
  const replyTo = useCallback((frame: SynaraProjectFrame) => {
    const target = frame.ref.current?.contentWindow;
    const documentIsCurrent = () => framesRef.current.some((current) =>
      current.ref === frame.ref && current.load === frame.load && current.ref.current?.contentWindow === target,
    );
    const post = (message: object) => {
      if (origin && target && documentIsCurrent()) target.postMessage(message, origin);
    };
    return { post, documentIsCurrent };
  }, [framesRef, origin]);

  const postMessage = useCallback(async (message: object) => {
    const root = projectRef.current?.root;
    const frame = framesRef.current.find((entry) => entry.root === root);
    if (!origin || !frame) return;
    const { post } = replyTo(frame);
    if ("type" in message && message.type === LATTICE_HOST_CONTEXT && !("editorComments" in message)) {
      const context = message as AgentHostContextSnapshot;
      if (context.workspaceRoot !== root) return;
      const options = latest.current.bridge.agentCommentsOptions();
      if (options?.workspaceRoot === context.workspaceRoot) {
        const { buildAgentCommentsSnapshot } = await loadAgentEditorComments();
        if (projectRef.current?.root !== context.workspaceRoot) return;
        message = {
          ...context,
          editorComments: buildAgentCommentsSnapshot({
            ...options, path: context.paper?.path ?? context.editor?.path, limit: 10,
          }),
        };
      }
    }
    if ("workspaceRoot" in message && message.workspaceRoot !== root) return;
    post(message);
  }, [framesRef, latest, origin, projectRef, replyTo]);
  // Keep a queued prompt with its own project until that document is ready.
  const [composerPromptRequest, setComposerPromptRequest] = useState(0);
  const sendComposerPrompt = useCallback((message: AgentComposerPromptMessage) => {
    if (!isFrameProjectActive(message.workspaceRoot)) return;
    mountFrame();
    contextFor(message.workspaceRoot).pendingPrompt = message;
    setComposerPromptRequest((request) => request + 1);
  }, [contextFor, isFrameProjectActive, mountFrame]);
  useEffect(() => {
    for (const frame of frames) {
      if (!origin || !frame.ready || !frame.ref.current) continue;
      const context = contextFor(frame.root);
      const message = context.pendingPrompt;
      if (!message) continue;
      context.pendingPrompt = null;
      if (message.mode === "draft" && isFrameProjectActive(frame.root)) frame.ref.current.focus();
      replyTo(frame).post(message);
    }
  }, [composerPromptRequest, contextFor, frames, isFrameProjectActive, origin, replyTo]);
  // Report Lattice's writes to the matching live turn, including parked turns.
  useEffect(() => {
    if (!origin || !frames.some((frame) => frame.ready)) return;
    setHostFileWritesSink((message) => {
      const frame = framesRef.current.find((entry) => entry.root === message.workspaceRoot && entry.ready);
      if (!frame?.ref.current) return false;
      replyTo(frame).post(message);
      return true;
    });
    return () => setHostFileWritesSink(null);
  }, [frames, framesRef, origin, replyTo]);

  const panelVisible = useCallback((root: string) => (
    projectRef.current?.root === root && latest.current.agentVisible
  ), [latest, projectRef]);
  const panelVisibility = useCallback((root: string) => ({
    type: LATTICE_AGENT_PANEL_VISIBILITY,
    visible: panelVisible(root),
    foreground: document.visibilityState !== "hidden" && document.hasFocus(),
  }), [panelVisible]);
  useEffect(() => {
    const notify = () => {
      for (const frame of frames) {
        if (frame.ready) replyTo(frame).post(panelVisibility(frame.root));
      }
    };
    notify();
    window.addEventListener("focus", notify);
    window.addEventListener("blur", notify);
    document.addEventListener("visibilitychange", notify);
    return () => {
      window.removeEventListener("focus", notify);
      window.removeEventListener("blur", notify);
      document.removeEventListener("visibilitychange", notify);
    };
  }, [agentVisible, frames, panelVisibility, projectRoot, replyTo]);

  // The editor's deck and checkpoints belong to the selected project.
  useEffect(() => {
    const context = projectRoot && frameMounted ? contextFor(projectRoot) : null;
    publishAgentDeckPresence(context?.deckPresence ?? null);
    const mode = context?.permissionMode;
    // eslint-disable-next-line react-hooks-js/set-state-in-effect -- restore state of the selected project's iframe
    setPermissionMode(isSynaraPermissionMode(mode?.mode) ? mode.mode : "full-access");
    setAutoModeAvailable(mode?.autoModeAvailable ?? true);
    if (context?.minimumWidth) trellis?.ui.set({ agentMinWidth: context.minimumWidth });
    setExpandedVisual(null);
    if (!context?.history) return;
    // useAgentCheckpoints resets its view on the same project commit.
    const frame = window.requestAnimationFrame(() => {
      if (projectRef.current?.root === projectRoot && context.history) {
        latest.current.bridge.onHistorySnapshot(context.history);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contextFor, frameMounted, latest, projectRef, projectRoot, serviceIdentity, trellis?.ui]);
  useEffect(() => () => publishAgentDeckPresence(null), []);
  const notifyPanelOpened = useCallback(() => {
    if (frameReady) void postMessage({ type: LATTICE_AGENT_PANEL_OPENED });
  }, [frameReady, postMessage]);
  const changePermissionMode = useCallback((mode: SynaraPermissionMode) => {
    void postMessage({ type: LATTICE_AGENT_PERMISSION_MODE_SET, mode });
  }, [postMessage]);
  /** Point a mounted agent frame at `threadId`; an unmounted one opens on the persisted thread instead. */
  const showThread = useCallback((threadId: string) => {
    const root = projectRef.current?.root;
    const frame = framesRef.current.find((entry) => entry.root === root)?.ref.current;
    if (!frame || !origin) return;
    const url = new URL(frame.src);
    url.pathname = `/${encodeURIComponent(threadId)}`;
    publishAgentDeckPresence(null);
    if (root) {
      contextFor(root).deckPresence = null;
      frameLoading(root);
    }
    frame.src = url.toString();
  }, [contextFor, frameLoading, framesRef, origin, projectRef]);

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
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || !event.source) return;
      const frame = framesRef.current.find((entry) => entry.ref.current?.contentWindow === event.source);
      if (!frame) return;
      const data = event.data as MessageData | null;
      if (!data || typeof data.type !== "string") return;
      const { root } = frame;
      const { post, documentIsCurrent } = replyTo(frame);
      const active = () => documentIsCurrent() && projectRef.current?.root === root ? root : null;
      const retained = () => documentIsCurrent() ? root : null;
      const host = latest.current;
      const context = contextFor(root);
      receiveProjectAgentActivity(root, data);

      // A file the agent named opens in the host's own surfaces (cached Paper
      // markdown goes through the reader, like links inside our own preview).
      const openNamedFile = (data: MessageData) => {
        const path = synaraProjectRelativeFilePath(data.filePath, root);
        if (path) host.bridge.openProjectPath(path);
        return Boolean(path);
      };
      /** Messages identified by their `type`. */
      const handlers: Record<string, (data: MessageData) => void> = {
        "synara:embed-ready": () => {
          frameBecameReady(frame);
          context.deckPresence = null;
          if (active()) publishAgentDeckPresence(null);
          post({ type: LATTICE_AGENT_PERMISSION_MODE_REQUEST });
          if (context.hostContext) {
            if (active()) void postMessage(context.hostContext);
            else post(context.hostContext);
          }
          if (context.paperLibrary) post(context.paperLibrary);
          if (hostTheme.current) post(hostTheme.current);
          post(panelVisibility(root));
          if (panelVisible(root)) post({ type: LATTICE_AGENT_PANEL_OPENED });
        },
        "synara:open-settings": (data) => {
          if (!active() || data.section !== "providers") return;
          setRuntimeRequested(true);
          host.bridge.openProviderSettings(synaraSettingsTarget(data.target));
        },
        "synara:open-file": (data) => { if (active()) openNamedFile(data); },
        "synara:open-external": (data) => {
          if (!active()) return;
          // WebKit does not hand an embedded frame's `_blank` navigation to the system browser.
          const url = stringField(data.url);
          if (/^https?:\/\//i.test(url)) void openUrl(url).catch(() => undefined);
        },
        [SYNARA_SAVE_VISUAL]: (data) => {
          if (!active()) return;
          const request = parseAgentVisualSave(data);
          if (request) saveAgentVisual(request);
        },
        [SYNARA_EXPAND_VISUAL]: (data) => {
          if (!active()) return;
          const visual = parseAgentVisualExpand(data);
          if (visual) setExpandedVisual(visual);
        },
        "synara:open-review": (data) => {
          if (!active()) return;
          // A file row opens in the host's file surface; the bare Review button
          // opens the drawer pinned to that turn's checkpoint diff, since the
          // working tree may already be clean.
          if (openNamedFile(data)) return;
          const threadId = stringField(data.threadId);
          const turnId = stringField(data.turnId);
          host.bridge.openReview(threadId && turnId ? { threadId, turnId } : null);
        },
        [LATTICE_HOST_CONTEXT_REQUEST]: (data) => {
          const snapshot = context.hostContext;
          if (data.refreshComments !== true) {
            if (snapshot) post(snapshot);
            return;
          }
          answerHostContextRefresh({
            requestId: data.requestId,
            workspaceRoot: data.workspaceRoot,
            context: snapshot,
            commentsOptions: () => {
              if (!active()) return null;
              host.bridge.flushVisualMarkdown();
              return host.bridge.agentCommentsOptions();
            },
            readComments: (options, current) => loadAgentEditorComments().then(({ readAgentCommentsSnapshot }) => (
              readAgentCommentsSnapshot({ ...options, path: current.paper?.path ?? current.editor?.path, limit: 10 })
            )),
            stillCurrent: () => active() === snapshot?.workspaceRoot,
            post,
          });
        },
        [LATTICE_PAPER_LIBRARY_REQUEST]: () => {
          if (context.paperLibrary) post(context.paperLibrary);
        },
        [LATTICE_HOST_THEME_REQUEST]: () => {
          if (hostTheme.current) post(hostTheme.current);
        },
        [LATTICE_HOST_CONTEXT_SELECTION_CLEAR]: () => { if (active()) host.bridge.clearSelection(); },
        "synara:editor-comments-tool-request": (data) => {
          void loadAgentEditorComments().then(async (tools) => {
            const request = tools.parseAgentEditorCommentsToolRequest(data);
            if (!request) return;
            if (!active()) {
              post(await backgroundToolError(request));
              return;
            }
            post(await tools.executeAgentEditorCommentsToolRequest(
              request,
              active,
              async (commentsRequest) => {
                host.bridge.flushVisualMarkdown();
                const options = host.bridge.agentCommentsOptions();
                if (!options) throw new Error("editor_comments_host_unavailable");
                return tools.readAgentCommentsSnapshot({ ...options, ...commentsRequest.args });
              },
            ));
          });
        },
        "synara:annotations-tool-request": (data) => {
          const request = parseAgentAnnotationsToolRequest(data);
          if (!request) return;
          void (active()
            ? executeAgentAnnotationsToolRequest(request, active, host.bridge.annotationTools())
            : backgroundToolError(request)
          ).then(post);
        },
        [SYNARA_COMPOSER_PROMPT_RESULT]: (data) => {
          const error = parseAgentComposerPromptResult(data)?.error;
          // The panel leaves a send it refuses in its composer as a draft. Every
          // other refusal is a stale or malformed request, nothing to act on.
          if (error?.code === "no-provider") {
            showWarning(i18n._(msg`Choose an AI provider in the agent panel, then send the request waiting in its composer.`), i18n._(msg`Agent`));
          } else if (error?.code === "awaiting-input") {
            showWarning(i18n._(msg`The agent is waiting for your answer. The request is in its composer; send it once you have answered.`), i18n._(msg`Agent`));
          } else if (error?.code === "send-failed") {
            showError(i18n._(msg`The agent could not send the request. It is waiting in the agent's composer.`), i18n._(msg`Agent`));
          }
        },
        [SYNARA_TURN_ACTIVITY]: (data) => {
          const activity = parseAgentTurnActivity(data);
          if (activity?.workspaceRoot !== root) return;
          if (activity.state === "running") markGetStartedStep("agent");
          context.deckPresence = nextAgentDeckPresence(
            context.deckPresence, activity, contextDeck(context.hostContext, root),
          );
          if (active()) publishAgentDeckPresence(context.deckPresence);
          scheduleRetirement(root);
        },
        "synara:agent-permission-mode": (data) => {
          if (!isSynaraPermissionMode(data.mode)) return;
          context.permissionMode = { mode: data.mode, autoModeAvailable: data.autoModeAvailable !== false };
          if (!active()) return;
          setPermissionMode(data.mode);
          setAutoModeAvailable(context.permissionMode.autoModeAvailable);
        },
        // The composer measures its own controls (latticeComposerLayout.ts in
        // Synara) and reports the frame width that keeps them, and the send
        // button, inside the box. An intrinsic width, so it may also decrease.
        "synara:layout-metrics": (data) => {
          const width = data.minimumSidebarWidth;
          if (typeof width !== "number" || !Number.isFinite(width)) return;
          context.minimumWidth = Math.round(
            Math.min(SYNARA_MINIMUM_WIDTH_CEILING, Math.max(SYNARA_MINIMUM_WIDTH_FLOOR, width)),
          );
          if (active()) trellis?.ui.set({ agentMinWidth: context.minimumWidth });
        },
      };
      const handler = Object.hasOwn(handlers, data.type) ? handlers[data.type] : undefined;
      scheduleRetirement(root);
      if (handler) {
        handler(data);
        return;
      }
      for (const route of TOOL_ROUTES) {
        const response = route(data, host.bridge, { root, active, retained });
        if (response) {
          void response.then(post);
          return;
        }
      }
      const historySnapshot = parseAgentProjectHistorySnapshot(data);
      if (historySnapshot) {
        context.history = historySnapshot;
        if (active()) host.bridge.onHistorySnapshot(historySnapshot);
        else persistSynaraThread(root, historySnapshot.activeThreadId);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [
    contextFor, frameBecameReady, framesRef, latest, origin, panelVisibility, panelVisible, postMessage,
    projectRef, replyTo, scheduleRetirement, trellis,
  ]);

  // The theme travels over the bridge rather than the frame URL, so a tint or
  // an accent dragged in the color picker repaints the agent without
  // reloading it. A frame that reloads (light/dark is still in its URL) gets
  // the snapshot again from its own embed-ready.
  const { theme, tint, accent, translucency, translucent } = appearance;
  useEffect(() => {
    const snapshot = readAgentHostTheme({ theme, tint, accent, translucency, translucent });
    hostTheme.current = snapshot;
    for (const frame of frames) {
      if (frame.ready) replyTo(frame).post(snapshot);
    }
  }, [theme, tint, accent, translucency, translucent, frames, replyTo]);

  const requestRuntime = useCallback(() => setRuntimeRequested(true), []);
  /**
   * The agent panel's Retry. A running service whose frame never sent
   * embed-ready gets a fresh frame; restarting the service instead would
   * reload every other frame on it too. One that is not running starts again.
   */
  const retryAgent = useCallback(() => {
    if (origin && projectRoot) retryProjectFrame(projectRoot);
    else retry();
  }, [origin, projectRoot, retry, retryProjectFrame]);
  return {
    runtime, retry, retryAgent, origin, requestRuntime, mountFrame,
    frames, sourceControlFrameRef, frameMounted, frameReady, frameLoading,
    isFrameProjectActive, selectFrameProject, retainBackgroundProject,
    permissionMode, autoModeAvailable, changePermissionMode,
    postMessage, notifyPanelOpened, showThread, sendComposerPrompt,
    expandedVisual, closeExpandedVisual,
    setContextSnapshots,
    deliverable: Boolean(origin && frameMounted && frameReady && agentVisible),
    /** The running service's identity: each launch makes a new token (useCompileRepair). */
    agentSession: runtime.state === "ready" ? runtime.authToken : null,
  };
}

export type SynaraHost = ReturnType<typeof useSynaraHost>;
