/**
 * The Agent island: the Tauri app's embedded Synara host
 * (`src/app/use-synara-host.ts`) as it is, in a page of its own, so the
 * Synara client in its iframe speaks to the same host, over the same
 * correlated postMessage protocol, as it does inside the Tauri app's window.
 * Its owner in the GPUI app is `crates/lattice-gpui/src/agent/`.
 *
 * One page serves three surfaces, as the Tauri app's one window serves its
 * Synara frames: `agent`, the Agent panel (`src/trellis/trellis-agent-surface.tsx`),
 * `git`, the Git workspace docked as a tool panel
 * (`src/app/app-history-drawers.tsx`, `git-workspace-frames.tsx`), and
 * `settings`, Settings › Providers (`settings.tsx`).
 *
 * What the host's modules ask the Tauri backend for (`invoke`: starting the
 * runtime, the bibliography mutations the Agent may not make itself, the
 * figure and visual tools) goes to the owner as `tauri:invoke`; what they
 * ask of the app's window (open a file, a turn's review, Settings) goes as
 * the events below. The theme is the host's: the bridge sets the root
 * element's attributes, the app's own stylesheets resolve every token from
 * them, and `readAgentHostTheme` reads the live cascade, so the snapshot
 * Synara paints with is the one the Tauri app posts. Nothing here styles the
 * embedded Agent.
 *
 * Host to page:
 *   agent:open        { surface, projectRoot, locale, visible, appearance, git? }   on every ready
 *   agent:visible     { visible }            the panel shown or hidden
 *   agent:opened                             the panel was brought forward
 *   agent:workspace   { … }                  what the writer is working in (useAgentContext's inputs)
 *   agent:appearance  { translucency, translucent, accent }
 *   agent:locale      { locale }
 *   agent:git         { view, turnReview }   the Git workspace's view
 *   agent:runtime-event { event, payload }   the runtime's own events (`synara-runtime-restarted`),
 *                                            as the Tauri backend emits them
 *   agent:pointer                            the pointer is over the app, not the page
 *   agent:notify-action { id, action }       a Synara notification's button, pressed in GPUI
 *   agent:settings-layout { compact }        Settings' compact insets, for `settings`
 *   agent:settings-target { target }         a place on Settings › Providers to reveal
 *   host:outside-pointerdown                 a press in the app (the bridge's)
 *   agent:deck-request { kind, deckPath }    Open Slide's request for the composer
 *   agent:files-changed { paths }            the project watcher's burst (`library.ts`)
 *   agent:overleaf    { linked, docPaths }   the project's Overleaf link (`library.ts`)
 * Page to host (requests):
 *   agent:document-tool, agent:create-document   the Agent's work on the window's documents (`documents.ts`)
 * Page to host:
 *   agent:notify      { … }                  a Synara notification, for the app's stack
 *   agent:open-path   { path }               a project file the Agent named
 *   agent:open-review { threadId, turnId }   a turn's review, or null for the working tree
 *   agent:open-settings { target? }          Settings › Providers
 *   agent:clear-selection
 *   agent:minimum-width { width }
 *   agent:history     { … }                  the Agent's checkpoint history
 *   agent:git-view    { view }               a Git view tab chosen
 *   agent:close-git
 *   agent:drawn                              the surface is up: reveal the page
 */
import "../shared/install";
// Ahead of the host's own message listener (`documents.ts`).
import { createProjectDocument, setDocumentToolTarget } from "./documents";
import { NOT_LINKED, overleafState, useAgentAnnotations, useAgentPaperLibrary, type OverleafState } from "./library";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ExternalLink, X } from "lucide-react";
import { mount, activateLocale } from "../shared/boot";
import { SettingsSurface, type SettingsLayout } from "./settings";
// Trellis's rules for the hosts its panels lay these surfaces in
// (`.trellis-agent-host`, `.trellis-tool-host > .trellis-docked-drawer`).
import "../../../src/trellis/trellis.css";
import "./agent.css";
import { host } from "../shared/host";
import { emitTauriEvent } from "../shared/tauri-internals";
import { i18n } from "../../../src/i18n";
import { useSynaraHost } from "../../../src/app/use-synara-host";
import TrellisAgentSurface from "../../../src/trellis/trellis-agent-surface";
import { GitWorkspaceFrames } from "../../../src/app/git-workspace-frames";
import { githubRepositoryUrl } from "../../../src/app/git-repository-url";
import { Tip } from "../../../src/components/icon-tip";
import { SlidingTabs } from "../../../src/components/ui/motion";
import { liveShortcuts } from "../../../src/app/use-app-commands";
import type { KeyCombo } from "../../../src/app/key-combos";
import {
  buildAgentHostContext,
  type AgentHostSurface,
  type AgentPdfDocumentPlace,
  type AgentSelectionLines,
} from "../../../src/agent/agent-host-context";
import { openSlideComposerPrompt } from "../../../src/agent/agent-composer-prompt";
import { useAgentSpreadsheetResolver } from "../../../src/app/use-agent-spreadsheet-resolver";
import type { OpenSlideAgentRequest } from "../../../src/editor/presentation/open-slide-agent-request";
import { parseSynaraNotificationMessage } from "../../../src/agent/synara-notifications";
import { SYNARA_POPUP_OPEN, LATTICE_OUTSIDE_POINTER_DOWN } from "../../../src/agent/synara-popup-dismissal";
import type { AgentGitWorkspaceView } from "../../../src/agent/synara-runtime";
import type { AgentTurnReview } from "../../../src/app/app-synara-embed";
import type { CanvasMode, EditorPosition, ProjectSnapshot } from "../../../src/app-types";
import type { ThemeAccent, ThemeTint, Translucency } from "../../../src/settings/theme-customization";

type Locale = "en" | "zh-CN";
type Surface = "agent" | "git" | "settings";

type Appearance = { translucency: Translucency; translucent: boolean; accent: ThemeAccent };

type GitState = { view: AgentGitWorkspaceView; turnReview: AgentTurnReview | null; remoteUrl: string | null };

type AgentOpen = {
  surface: Surface;
  projectRoot: string;
  locale: Locale;
  visible: boolean;
  appearance: Appearance;
  git?: GitState;
};

/** useAgentContext's inputs, as the owner reads them from the window. */
type Workspace = {
  activeFile: string;
  editorPosition: EditorPosition | null;
  canvasMode: CanvasMode;
  pdfPage: number;
  pdfPageCount: number | null;
  selection: string;
  /** The whole selection's length; `selection` is cut to 24,000 characters. */
  selectionLength: number | null;
  selectionSource: AgentHostSurface | null;
  selectionLines: AgentSelectionLines | null;
  selectionPdfDocument: AgentPdfDocumentPlace | null;
  activeSurface: AgentHostSurface;
};

const EMPTY_WORKSPACE: Workspace = {
  activeFile: "",
  editorPosition: null,
  canvasMode: "split",
  pdfPage: 1,
  pdfPageCount: null,
  selection: "",
  selectionLength: null,
  selectionSource: null,
  selectionLines: null,
  selectionPdfDocument: null,
  activeSurface: "editor",
};

/** How long after its commit the surface is taken to have drawn (see the slides island). */
const DRAWN_DELAY_MS = 120;

/**
 * The app's shortcuts the host relays to this page (`host:relay`, as
 * `meta+shift+KeyK` combinations) in the command table's own form, so the
 * Tauri app's `useSynaraHostShortcuts` tells each Synara frame which keys
 * to hand back. A key it hands back is dispatched on the frame's element,
 * where the bridge's own listener sends it to GPUI.
 */
function relayCombos(relay: readonly string[], primaryIsMeta: boolean): Required<KeyCombo>[] {
  const named: Record<string, string> = {
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
    Semicolon: ";", Quote: "'", Minus: "-", Equal: "=", Backquote: "`", Space: " ",
  };
  return relay.flatMap((combo) => {
    const parts = combo.split("+");
    const code = parts.pop() ?? "";
    const has = (name: string) => parts.includes(name);
    let key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase()
      : /^Digit\d$/.test(code) ? code.slice(5)
        : named[code] ?? code.replace(/^Arrow/, "arrow").toLowerCase();
    if (code === "Slash" && has("shift")) key = "?";
    if (!key) return [];
    const meta = has("meta");
    const ctrl = has("ctrl");
    return [{
      key,
      mod: primaryIsMeta ? meta : ctrl,
      ctrl: primaryIsMeta ? ctrl : false,
      shift: has("shift"),
      alt: has("alt"),
    }];
  });
}

/** The root element's theme attributes, which the bridge keeps as the host's. */
function rootTheme() {
  const dataset = document.documentElement.dataset;
  return {
    theme: dataset.theme === "dark" ? "dark" as const : "light" as const,
    tint: (dataset.tint ?? "graphite") as ThemeTint,
  };
}

function useRootTheme() {
  const [theme, setTheme] = useState(rootTheme);
  useEffect(() => host().on("host:theme", () => setTheme(rootTheme())), []);
  return theme;
}

const noop = () => undefined;

/** Open Slide's last request for the composer, numbered so a repeat is a new one. */
type DeckRequest = { request: OpenSlideAgentRequest; nonce: number };

function Agent({ opened, workspace, visible, appearance, git, overleaf, deckRequest, takeDeckRequest }: {
  opened: AgentOpen;
  workspace: Workspace;
  visible: boolean;
  appearance: Appearance;
  git: GitState;
  overleaf: OverleafState;
  deckRequest: DeckRequest | null;
  /** The request reached the composer: it is not sent again (another project's Agent, a rebuilt surface). */
  takeDeckRequest: (nonce: number) => void;
}) {
  const { t } = useLingui();
  const { theme, tint } = useRootTheme();
  const project = useMemo(() => ({ root: opened.projectRoot }) as ProjectSnapshot, [opened.projectRoot]);
  const projectRef = useRef(project);
  projectRef.current = project;
  const projectRootRef = useRef<string | null>(opened.projectRoot);
  projectRootRef.current = opened.projectRoot;
  const agentVisible = opened.surface === "agent" && visible;
  // The project's annotations and comments, held by this page (`library.ts`).
  const annotations = useAgentAnnotations(opened.projectRoot, overleaf);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  // A closed sheet the range tools change is read from and written to disk,
  // where the watcher hands it to the window (`use-agent-spreadsheet-resolver.ts`).
  useAgentSpreadsheetResolver(projectRootRef, noop);

  const bridge = useMemo(() => ({
    openProviderSettings: (target?: string) => host().post("agent:open-settings", { target: target ?? null }),
    openProjectPath: (path: string) => host().post("agent:open-path", { path }),
    openReview: (turn: { threadId: string; turnId: string } | null) => host().post("agent:open-review", turn),
    clearSelection: () => host().post("agent:clear-selection"),
    // The visual LaTeX editor is not in the GPUI app: nothing waits to be written.
    flushVisualMarkdown: noop,
    agentCommentsOptions: () => annotationsRef.current.commentsOptions(),
    annotationTools: () => annotationsRef.current.annotationTools(),
    projectDocumentCreator: () => createProjectDocument,
    onHistorySnapshot: (snapshot: unknown) => host().post("agent:history", snapshot),
    onMinimumWidth: (width: number) => host().post("agent:minimum-width", { width }),
  }), []);

  const synara = useSynaraHost({
    project,
    projectRef,
    agentVisible,
    bridge,
    appearance: { theme, tint, accent: appearance.accent, translucency: appearance.translucency, translucent: appearance.translucent },
  });
  const { latest, deliverable, postMessage, requestRuntime, origin, frameRef, sourceControlFrameRef } = synara;

  // The Git workspace starts the runtime as the Tauri app's Git button does.
  useEffect(() => {
    if (opened.surface === "git") requestRuntime();
  }, [opened.surface, requestRuntime]);

  // The Agent frame takes its canvas, spreadsheet and presentation tool
  // calls through the owner's documents (`documents.ts`).
  useEffect(() => {
    if (opened.surface !== "agent" || !origin) return;
    setDocumentToolTarget({
      frame: () => frameRef.current?.contentWindow ?? null,
      origin,
      projectRoot: opened.projectRoot,
      post: (message) => void postMessage(message),
    });
    return () => setDocumentToolTarget(null);
  }, [frameRef, opened.projectRoot, opened.surface, origin, postMessage]);

  // Open Slide's Ask AI, Apply comments and Draft a deck
  // (`onOpenSlideAgentRequest` in `use-document-surfaces.tsx`).
  const sendComposerPrompt = synara.sendComposerPrompt;
  useEffect(() => {
    if (deckRequest && opened.surface === "agent") {
      sendComposerPrompt(openSlideComposerPrompt(deckRequest.request, opened.projectRoot));
      takeDeckRequest(deckRequest.nonce);
    }
  }, [deckRequest, opened.projectRoot, opened.surface, sendComposerPrompt, takeDeckRequest]);

  // useAgentContext's snapshots, from what the owner reports of the window.
  const hostContext = useMemo(() => buildAgentHostContext({
    workspaceRoot: opened.projectRoot,
    activeFile: workspace.activeFile,
    editorPosition: workspace.editorPosition,
    activePaper: null,
    canvasMode: workspace.canvasMode,
    paperView: "blog",
    pdfPage: workspace.pdfPage,
    pdfPageCount: workspace.pdfPageCount,
    presentation: null,
    selection: workspace.selection,
    selectionLength: workspace.selectionLength,
    selectionSource: workspace.selectionSource,
    selectionLines: workspace.selectionLines,
    selectionPdfDocument: workspace.selectionPdfDocument,
    selectionImage: null,
    activeSurface: workspace.activeSurface,
  }), [opened.projectRoot, workspace]);
  const paperLibrary = useAgentPaperLibrary(opened.projectRoot);
  useEffect(() => {
    Object.assign(latest.current, { hostContext, paperLibrary });
  }, [hostContext, latest, paperLibrary]);
  useEffect(() => {
    if (!deliverable) return;
    const frame = window.requestAnimationFrame(() => void postMessage(hostContext));
    return () => window.cancelAnimationFrame(frame);
  }, [deliverable, hostContext, postMessage]);
  useEffect(() => {
    if (!deliverable) return;
    const frame = window.requestAnimationFrame(() => void postMessage(paperLibrary));
    return () => window.cancelAnimationFrame(frame);
  }, [deliverable, paperLibrary, postMessage]);

  // The window's other surfaces, and the frames' own messages the page
  // answers itself.
  const synaraRef = useRef(synara);
  synaraRef.current = synara;
  useEffect(() => {
    const bridgeHost = host();
    const frameWindow = () => (opened.surface === "git" ? sourceControlFrameRef : frameRef).current?.contentWindow ?? null;
    let popupOpen = false;
    const stops = [
      bridgeHost.on("agent:opened", () => synaraRef.current.notifyPanelOpened()),
      // WebKit drops pointerleave when the pointer leaves for GPUI, as it
      // does for the Tauri app's own window; the host's movement stands in.
      bridgeHost.on("agent:pointer", () => {
        const target = frameWindow();
        if (target && origin) target.postMessage({ type: "lattice:host-pointer" }, origin);
      }),
      // A press in GPUI closes an open Synara popup, as a press in the Tauri
      // app's window does (synara-popup-dismissal.ts).
      bridgeHost.on("host:outside-pointerdown", () => {
        const target = frameWindow();
        if (!popupOpen || !target || !origin) return;
        popupOpen = false;
        target.postMessage({ type: LATTICE_OUTSIDE_POINTER_DOWN }, origin);
      }),
      bridgeHost.on("agent:notify-action", (payload) => {
        const { id, action } = (payload ?? {}) as { id?: unknown; action?: unknown };
        const target = frameWindow();
        if (target && origin && typeof id === "string" && typeof action === "string") {
          target.postMessage({ type: "lattice:embedded-notification-action", id, action }, origin);
        }
      }),
      bridgeHost.on("host:relay", (payload) => {
        liveShortcuts.publish(relayCombos(Array.isArray(payload) ? payload : [], bridgeHost.primaryIsMeta));
      }),
    ];
    liveShortcuts.publish(relayCombos(bridgeHost.relay(), bridgeHost.primaryIsMeta));
    const onMessage = (event: MessageEvent) => {
      if (!origin || event.origin !== origin || event.source !== frameWindow()) return;
      const data = event.data as { type?: unknown; open?: unknown } | null;
      if (data?.type === SYNARA_POPUP_OPEN && typeof data.open === "boolean") popupOpen = data.open;
      else if (data?.type === "synara:embed-ready") popupOpen = false;
      // Synara's notifications go to the app's stack with their buttons and
      // progress, rather than through the page's own toast relay.
      const notification = parseSynaraNotificationMessage(event.data);
      if (notification) bridgeHost.post("agent:notify", notification);
    };
    window.addEventListener("message", onMessage);
    return () => {
      for (const stop of stops) stop();
      window.removeEventListener("message", onMessage);
    };
  }, [frameRef, opened.surface, origin, sourceControlFrameRef]);

  if (opened.surface === "git") {
    const frame = origin ? {
      origin,
      authToken: synara.runtime.authToken,
      projectRoot: opened.projectRoot,
      theme,
      locale: opened.locale,
    } : null;
    const repositoryUrl = githubRepositoryUrl(git.remoteUrl);
    return (
      <div className="trellis-tool-host agent-island-host">
        <aside className="history-drawer resizable-drawer native-hover-scrollbar trellis-docked-drawer git-drawer synara-source-control-drawer" data-tour="git-panel">
          <div className="agent-git-workspace-header">
            <SlidingTabs
              value={git.turnReview ? "agent-turn" : git.view}
              onChange={(value) => {
                if (value !== "agent-turn") host().post("agent:git-view", { view: value });
              }}
              ariaLabel={t`Git workspace`}
              variant="none"
              className="agent-git-workspace-tabs drawer-view-tabs"
              tabClassName="drawer-view-tab"
              items={[
                ...(git.turnReview ? [{ value: "agent-turn", label: t`Agent turn` }] : []),
                { value: "changes", label: t({ message: "Changes", context: "git panel" }) },
                { value: "pull-requests", label: t`Pull requests` },
              ]}
            />
            <div className="agent-git-workspace-actions">
              {repositoryUrl ? (
                <Tip label={t`Open this repository on GitHub`}>
                  <button
                    type="button"
                    className="agent-git-workspace-repository"
                    onClick={() => void host().request("tauri:invoke", { command: "plugin:opener|open_url", args: { url: repositoryUrl }, base64: null, headers: {} })}
                  >
                    <span>GitHub</span>
                    <ExternalLink size={13} aria-hidden="true" />
                  </button>
                </Tip>
              ) : null}
              <button
                type="button"
                className="agent-git-workspace-close"
                aria-label={t`Close Git workspace`}
                onClick={() => host().post("agent:close-git")}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <GitWorkspaceFrames
            key={opened.projectRoot}
            frame={frame}
            view={git.view}
            turnReview={git.turnReview}
            runtime={synara.runtime}
            onRetryRuntime={synara.retry}
            frameRef={sourceControlFrameRef}
          />
        </aside>
      </div>
    );
  }
  return (
    <div className="trellis-agent-host agent-island-host">
      <TrellisAgentSurface
        synara={synara}
        projectRoot={opened.projectRoot}
        theme={theme}
        appLocale={opened.locale}
        dropActive={false}
      />
    </div>
  );
}

function AgentIsland() {
  const [opened, setOpened] = useState<AgentOpen | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE);
  const [appearance, setAppearance] = useState<Appearance>({ translucency: "subtle", translucent: false, accent: "graphite" });
  const [git, setGit] = useState<GitState>({ view: "changes", turnReview: null, remoteUrl: null });
  const [settings, setSettings] = useState<SettingsLayout>({ compact: false, target: null });
  const [overleaf, setOverleaf] = useState<OverleafState>(NOT_LINKED);
  const [deckRequest, setDeckRequest] = useState<DeckRequest | null>(null);
  const takeDeckRequest = useCallback((nonce: number) => {
    setDeckRequest((current) => (current?.nonce === nonce ? null : current));
  }, []);
  const { theme, tint } = useRootTheme();
  const switchLocale = useCallback((locale: Locale) => activateLocale(locale), []);

  useEffect(() => {
    const bridge = host();
    const stops = [
      bridge.on("agent:open", (payload) => {
        const open = payload as AgentOpen;
        setOpened(open);
        setOverleaf(NOT_LINKED);
        setVisible(open.visible);
        setAppearance(open.appearance);
        if (open.git) setGit(open.git);
        void switchLocale(open.locale).then(() => setReady(true));
      }),
      // A restart asks every surface for the new runtime (use-synara-runtime.ts).
      bridge.on("agent:runtime-event", (payload) => {
        const { event, payload: detail } = (payload ?? {}) as { event?: unknown; payload?: unknown };
        if (typeof event === "string") emitTauriEvent(event, detail ?? null);
      }),
      // Held here, above the surface: one that arrives with the page's
      // first open reaches the Agent once it is up.
      bridge.on("agent:deck-request", (payload) => {
        const request = payload as OpenSlideAgentRequest | null;
        if (request && typeof request.kind === "string") {
          setDeckRequest((current) => ({ request, nonce: (current?.nonce ?? 0) + 1 }));
        }
      }),
      bridge.on("agent:visible", (payload) => setVisible(Boolean((payload as { visible?: unknown } | null)?.visible))),
      bridge.on("agent:overleaf", (payload) => setOverleaf(overleafState(payload))),
      bridge.on("agent:workspace", (payload) => setWorkspace({ ...EMPTY_WORKSPACE, ...(payload as Partial<Workspace>) })),
      bridge.on("agent:appearance", (payload) => setAppearance(payload as Appearance)),
      bridge.on("agent:git", (payload) => setGit((current) => ({ ...current, ...(payload as Partial<GitState>) }))),
      bridge.on("agent:settings-layout", (payload) => {
        const compact = Boolean((payload as { compact?: unknown } | null)?.compact);
        setSettings((current) => ({ ...current, compact }));
      }),
      bridge.on("agent:settings-target", (payload) => {
        const target = (payload as { target?: unknown } | null)?.target;
        if (typeof target === "string") setSettings((current) => ({ ...current, target: { target } }));
      }),
      bridge.on("agent:locale", (payload) => {
        const locale = (payload as { locale: Locale }).locale;
        void switchLocale(locale).then(() => setOpened((current) => current && { ...current, locale }));
      }),
    ];
    bridge.ready();
    return () => { for (const stop of stops) stop(); };
  }, [switchLocale]);

  useEffect(() => {
    if (!opened || !ready) return;
    // A timer, not animation frames: WebKit runs no frames for a page still
    // clipped away, and the host reveals it only on this.
    const timer = window.setTimeout(() => host().post("agent:drawn"), DRAWN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [opened, ready]);

  if (!opened || !ready) return null;
  if (opened.surface === "settings") {
    return (
      <SettingsSurface
        key={opened.projectRoot}
        projectRoot={opened.projectRoot}
        locale={opened.locale}
        theme={theme}
        tint={tint}
        appearance={appearance}
        layout={settings}
      />
    );
  }
  return <Agent key={`${opened.surface}\n${opened.projectRoot}`} opened={opened} workspace={workspace} visible={visible} appearance={appearance} git={git} overleaf={overleaf} deckRequest={deckRequest} takeDeckRequest={takeDeckRequest} />;
}

mount(() => <AgentIsland />, {
  // Synara's own notifications reach the app's stack from the page above,
  // with their buttons; the page's toast relay would show them again. The
  // sources are use-synara-host.ts's, in the interface language.
  relayToast: (entry) => entry.source !== i18n._(msg`Synara agent`) && entry.source !== i18n._(msg`Synara source control`),
});
