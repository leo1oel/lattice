import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSnapshot } from "../app-types";
import type { TrellisController } from "../trellis/trellis-controller";
import type { AgentComposerPromptMessage } from "../agent/agent-composer-prompt";
import { LATTICE_HOST_CONTEXT, type AgentHostContextSnapshot } from "../agent/agent-host-context";
import { readAgentHostTheme, type AgentHostThemeSnapshot } from "../agent/agent-host-theme";
import type { AgentPaperLibrarySnapshot } from "../agent/agent-paper-library";
import { publishAgentDeckPresence } from "../agent/agent-turn-activity";
import type { AgentVisualExpand } from "../agent/agent-visual-save";
import { useSynaraConfirmationBridge } from "../agent/synara-confirmations";
import { useSynaraNotificationBridge } from "../agent/synara-notifications";
import { useSynaraPopupDismissalBridge } from "../agent/synara-popup-dismissal";
import { useSynaraHostShortcuts } from "../agent/synara-host-shortcuts";
import { receiveProjectAgentActivity } from "../agent/project-agent-activity";
import { useSynaraRuntime } from "../agent/use-synara-runtime";
import { isSynaraPermissionMode, type SynaraPermissionMode } from "./app-synara-embed";
import { useLatestRef } from "../hooks/use-latest-ref";
import { setHostFileWritesSink } from "../agent/agent-host-writes";
import { useSynaraProjectFrames, type SynaraProjectFrame } from "./use-synara-project-frames";
import { chunk } from "../lib/lazy-chunk";
import type { MessageData, SynaraFrameMessageScope, SynaraHostBridge } from "./synara-host-messages";

export type { SynaraSettingsTarget } from "./synara-host-messages";

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
// Keep import expressions outside the component: React Compiler cannot lower them.
function loadAgentEditorComments() {
  return import("../agent/agent-editor-comments");
}
/** The frame message routes; no message arrives before the service is ready. */
export const loadSynaraHostMessages = chunk(() => import("./synara-host-messages"));

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
  const {
    frames, framesRef, rootRef: projectRootRef, currentFrame, contextFor, mountProjectFrame, frameLoading, frameBecameReady,
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
    let disposed = false;
    void loadSynaraHostMessages().catch(() => undefined);
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || !event.source) return;
      const frame = framesRef.current.find((entry) => entry.ref.current?.contentWindow === event.source);
      if (!frame) return;
      const data = event.data as MessageData | null;
      const type = data?.type;
      if (!data || typeof type !== "string") return;
      const { root } = frame;
      const { post, documentIsCurrent } = replyTo(frame);
      const active = () => documentIsCurrent() && projectRef.current?.root === root ? root : null;
      const retained = () => documentIsCurrent() ? root : null;
      const host = latest.current;
      const context = contextFor(root);
      receiveProjectAgentActivity(root, data);
      scheduleRetirement(root);
      const scope: SynaraFrameMessageScope = {
        root, context, bridge: host.bridge, post, active, retained,
        hostTheme: () => hostTheme.current,
        embedReady: () => {
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
        requestRuntime: () => setRuntimeRequested(true),
        expandVisual: setExpandedVisual,
        showPermissionMode: (mode, autoMode) => {
          setPermissionMode(mode);
          setAutoModeAvailable(autoMode);
        },
        showMinimumWidth: (width) => trellis?.ui.set({ agentMinWidth: width }),
        scheduleRetirement: () => scheduleRetirement(root),
        loadEditorComments: loadAgentEditorComments,
      };
      // Messages wait for the routes in the order they came.
      const messages = loadSynaraHostMessages.loaded();
      if (messages) messages.receiveSynaraFrameMessage(type, data, scope);
      else void loadSynaraHostMessages().then(({ receiveSynaraFrameMessage }) => {
        if (!disposed) receiveSynaraFrameMessage(type, data, scope);
      });
    };
    window.addEventListener("message", receive);
    return () => {
      disposed = true;
      window.removeEventListener("message", receive);
    };
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
