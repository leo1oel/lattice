/**
 * What the host does with each message an Agent frame posts. Loaded once the
 * Agent's service is ready (`useSynaraHost`), since no frame, and so no
 * message, exists before then: the routes and the tools they reach stay off
 * the startup path.
 */
import { msg } from "@lingui/core/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { executeAgentBibliographyToolRequest, parseAgentBibliographyToolRequest } from "../agent/agent-bibliography-tools";
import { executeAgentCanvasToolRequest, parseAgentCanvasToolRequest } from "../agent/agent-canvas-tools";
import {
  executeAgentAnnotationsToolRequest, parseAgentAnnotationsToolRequest, type AnnotationToolHost,
} from "../agent/agent-annotations";
import { SYNARA_COMPOSER_PROMPT_RESULT, parseAgentComposerPromptResult } from "../agent/agent-composer-prompt";
import type { BuildAgentCommentsOptions } from "../agent/agent-editor-comments";
import {
  LATTICE_HOST_CONTEXT_REQUEST, LATTICE_HOST_CONTEXT_SELECTION_CLEAR, answerHostContextRefresh,
} from "../agent/agent-host-context";
import { LATTICE_HOST_THEME_REQUEST, type AgentHostThemeSnapshot } from "../agent/agent-host-theme";
import { LATTICE_PAPER_LIBRARY_REQUEST } from "../agent/agent-paper-library";
import {
  executeAgentProjectDocumentToolRequest, parseAgentProjectDocumentToolRequest, rejectAgentProjectDocumentToolRequest,
  type AgentProjectDocumentToolRequest,
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
import { parseAgentProjectHistorySnapshot, synaraProjectRelativeFilePath } from "../agent/synara-runtime";
import { runAgentTool, toolError } from "../agent/agent-protocol";
import { markGetStartedStep } from "../onboarding/get-started-progress";
import { announceBibliographyWrite } from "../project/project-files-changed";
import { isSynaraPermissionMode, persistSynaraThread, type SynaraPermissionMode } from "./app-synara-embed";
import { i18n } from "../i18n";
import { showError, showWarning } from "./notify";
import type { ProjectFrameContext } from "./use-synara-project-frames";

/**
 * Bounds for the width the agent's composer reports it needs (its controls
 * side by side, the send button inside the box). The ceiling only guards
 * against a malformed report.
 */
const SYNARA_MINIMUM_WIDTH_FLOOR = 180;
const SYNARA_MINIMUM_WIDTH_CEILING = 720;

/**
 * The places on Synara's settings pages the agent panel may open Settings on: the
 * no-agent notice's "Set path…" opens Claude Code's and Codex's binary path fields.
 */
const SYNARA_SETTINGS_TARGETS = ["provider-binary-paths"] as const;
export type SynaraSettingsTarget = (typeof SYNARA_SETTINGS_TARGETS)[number];
const synaraSettingsTarget = (value: unknown): SynaraSettingsTarget | undefined =>
  SYNARA_SETTINGS_TARGETS.find((target) => target === value);

/** What the embedded agent can reach in the host; read at message time. */
export type SynaraHostBridge = {
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

export type MessageData = Record<string, unknown> & { type?: unknown };

/** One message's frame, the project it belongs to, and the host state it may change. */
export type SynaraFrameMessageScope = {
  root: string;
  context: ProjectFrameContext;
  bridge: SynaraHostBridge;
  /** Reply to the frame that sent the message, while that document is still current. */
  post: (message: object) => void;
  /** `root` while the frame's document is current and its project is selected. */
  active: () => string | null;
  /** `root` while the frame's document is current, selected or not. */
  retained: () => string | null;
  hostTheme: () => AgentHostThemeSnapshot | null;
  embedReady: () => void;
  requestRuntime: () => void;
  expandVisual: (visual: AgentVisualExpand) => void;
  showPermissionMode: (mode: SynaraPermissionMode, autoModeAvailable: boolean) => void;
  showMinimumWidth: (width: number) => void;
  scheduleRetirement: () => void;
  loadEditorComments: () => Promise<typeof import("../agent/agent-editor-comments")>;
};

type ToolRouteScope = Pick<SynaraFrameMessageScope, "root" | "retained" | "active">;

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

/** Answer one message from a project's Agent frame, within that frame's workspace. */
export function receiveSynaraFrameMessage(type: string, data: MessageData, scope: SynaraFrameMessageScope) {
  const { root, context, bridge, post, active } = scope;

  // A file the agent named opens in the host's own surfaces (cached Paper
  // markdown goes through the reader, like links inside our own preview).
  const openNamedFile = (data: MessageData) => {
    const path = synaraProjectRelativeFilePath(data.filePath, root);
    if (path) bridge.openProjectPath(path);
    return Boolean(path);
  };
  /** Messages identified by their `type`. */
  const handlers: Record<string, (data: MessageData) => void> = {
    "synara:embed-ready": scope.embedReady,
    "synara:open-settings": (data) => {
      if (!active() || data.section !== "providers") return;
      scope.requestRuntime();
      bridge.openProviderSettings(synaraSettingsTarget(data.target));
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
      if (visual) scope.expandVisual(visual);
    },
    "synara:open-review": (data) => {
      if (!active()) return;
      // A file row opens in the host's file surface; the bare Review button
      // opens the drawer pinned to that turn's checkpoint diff, since the
      // working tree may already be clean.
      if (openNamedFile(data)) return;
      const threadId = stringField(data.threadId);
      const turnId = stringField(data.turnId);
      bridge.openReview(threadId && turnId ? { threadId, turnId } : null);
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
          bridge.flushVisualMarkdown();
          return bridge.agentCommentsOptions();
        },
        readComments: (options, current) => scope.loadEditorComments().then(({ readAgentCommentsSnapshot }) => (
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
      const theme = scope.hostTheme();
      if (theme) post(theme);
    },
    [LATTICE_HOST_CONTEXT_SELECTION_CLEAR]: () => { if (active()) bridge.clearSelection(); },
    "synara:editor-comments-tool-request": (data) => {
      void scope.loadEditorComments().then(async (tools) => {
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
            bridge.flushVisualMarkdown();
            const options = bridge.agentCommentsOptions();
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
        ? executeAgentAnnotationsToolRequest(request, active, bridge.annotationTools())
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
      scope.scheduleRetirement();
    },
    "synara:agent-permission-mode": (data) => {
      if (!isSynaraPermissionMode(data.mode)) return;
      context.permissionMode = { mode: data.mode, autoModeAvailable: data.autoModeAvailable !== false };
      if (active()) scope.showPermissionMode(data.mode, context.permissionMode.autoModeAvailable);
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
      if (active()) scope.showMinimumWidth(context.minimumWidth);
    },
  };
  const handler = Object.hasOwn(handlers, type) ? handlers[type] : undefined;
  if (handler) {
    handler(data);
    return;
  }
  for (const route of TOOL_ROUTES) {
    const response = route(data, bridge, scope);
    if (response) {
      void response.then(post);
      return;
    }
  }
  const historySnapshot = parseAgentProjectHistorySnapshot(data);
  if (historySnapshot) {
    context.history = historySnapshot;
    if (active()) bridge.onHistorySnapshot(historySnapshot);
    else persistSynaraThread(root, historySnapshot.activeThreadId);
  }
}
