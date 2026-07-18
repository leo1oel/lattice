import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import { latex } from "codemirror-lang-latex";
import DOMPurify from "dompurify";
import { gsap } from "gsap";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Download,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Image,
  ImagePlus,
  KeyRound,
  Library,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Pencil,
  RotateCcw,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { marked } from "marked";
import { latexEditorExtensions, latexLanguageOptions } from "./latex-editor";
import { latexFigureInsertion } from "./figure-insertion";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

type RootDocument = {
  path: string;
  name: string;
  isDefault: boolean;
};

type ProjectManifest = {
  schemaVersion: number;
  projectId: string;
  name: string;
  rootDocuments: RootDocument[];
  primaryBibliography: string;
  trusted: boolean;
};

type FileNode = {
  name: string;
  path: string;
  kind: string;
  children: FileNode[];
};

type ProjectSnapshot = {
  root: string;
  manifest: ProjectManifest;
  files: FileNode[];
};

type AssetPreview = {
  path: string;
  mimeType: string;
  base64: string;
};

type FigureDropRequest = {
  id: string;
  paths: string[];
  clientX: number;
  clientY: number;
};

type FigurePointerDrag = {
  path: string;
  label: string;
  clientX: number;
  clientY: number;
  overEditor: boolean;
};

type SyncTexTarget = {
  path: string;
  line: number;
};

type EditorNavigation = SyncTexTarget & { id: string };

type ProjectSearchResult = {
  kind: "file" | "paper";
  path: string;
  title: string;
  snippet: string;
  arxivId?: string;
  fileKind?: string;
};

type Diagnostic = {
  file?: string;
  line?: number;
  level: string;
  message: string;
};

type BuildResult = {
  success: boolean;
  pdfBase64?: string;
  log: string;
  durationMs: number;
  diagnostics: Diagnostic[];
};

type HistoryItem = {
  id: string;
  label: string;
  timestamp: string;
  files: string[];
};

type AgentResult = {
  summary: string;
  changedFiles: string[];
  transactionId?: string;
  skillsUsed: string[];
};

type AgentStreamEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string };

type PaperSummary = {
  arxivId: string;
  title: string;
  citationKey?: string;
};

type RenameTarget =
  | { kind: "entry"; path: string; name: string }
  | { kind: "paper"; paper: PaperSummary };

type ChatMessage = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  files?: string[];
  skills?: string[];
};

type AgentSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  messages: ChatMessage[];
};

type AgentSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  messageCount: number;
};

type AgentSessionSearchResult = AgentSessionSummary & { snippet: string };
type AgentSkill = {
  name: string;
  description: string;
  scope: "built-in" | "application" | "project";
  enabled: boolean;
  editable: boolean;
  overridden: boolean;
  content: string;
};
type SkillDraft = { originalName?: string; scope: "application" | "project"; content: string };
type AgentMention = { key: string; label: string; path: string; kind: "file" | "paper" };
type MentionState = { start: number; end: number; query: string };

type CanvasMode = "source" | "pdf" | "split" | "paper" | "asset";
type Theme = "light" | "dark";
type AgentProvider = "codex" | "claude" | "openai-api" | "anthropic-api";
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type RecentProject = { name: string; path: string };
type PanelKind = "navigator" | "agent";
type PanelWidths = { navigator: number; agent: number };
type SettingsTab = "appearance" | "editor" | "agent" | "accounts" | "api";
type AppearanceSettings = { uiFont: string; interfaceScale: number; editorFont: string; editorFontSize: number };
type AutoBuildMode = "manual" | "automatic";
type BuildPreferences = { autoBuildMode: AutoBuildMode };
type SubscriptionStatus = { provider: "codex" | "claude"; installed: boolean; loggedIn: boolean; detail: string };
type ModelOption = { value: string; label: string; efforts: ReasoningEffort[] };

const RECENT_PROJECTS_KEY = "lattice.recent-projects.v1";
const PANEL_WIDTHS_KEY = "lattice.panel-widths.v1";
const APPEARANCE_KEY = "lattice.appearance.v3";
const LEGACY_APPEARANCE_KEY = "lattice.appearance.v2";
const THEME_KEY = "lattice.theme.v1";
const BUILD_PREFERENCES_KEY = "lattice.build-preferences.v2";
const SPLIT_RATIO_KEY = "lattice.split-ratio.v1";
const NAVIGATOR_SPLIT_KEY = "lattice.navigator-split.v1";
const AGENT_SYSTEM_PROMPT_KEY = "lattice.agent-system-prompt.v1";
const PROJECT_FIGURE_DRAG_TYPE = "application/x-lattice-project-figure";

const defaultWelcomeMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "agent",
    text: "What would you like to work on?",
  },
];

function App() {
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [activeFile, setActiveFile] = useState("");
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [selection, setSelection] = useState("");
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("split");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [citationKeys, setCitationKeys] = useState<string[]>([]);
  const [activePaper, setActivePaper] = useState<PaperSummary | null>(null);
  const [paperMarkdown, setPaperMarkdown] = useState("");
  const [activeAsset, setActiveAsset] = useState<AssetPreview | null>(null);
  const [nativeEditorDropActive, setNativeEditorDropActive] = useState(false);
  const [figureDropRequest, setFigureDropRequest] = useState<FigureDropRequest | null>(null);
  const [figurePointerDrag, setFigurePointerDrag] = useState<FigurePointerDrag | null>(null);
  const suppressedFigureClick = useRef<string | null>(null);
  const [editorNavigation, setEditorNavigation] = useState<EditorNavigation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(defaultWelcomeMessages);
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [branchSource, setBranchSource] = useState<{ sessionId: string; messageId: string } | null>(null);
  const [agentInput, setAgentInput] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [agentModel, setAgentModel] = useState(defaultModel("codex"));
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const [importInput, setImportInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [assetImporting, setAssetImporting] = useState(false);
  const [assetDropTarget, setAssetDropTarget] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(true);
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(loadPanelWidths);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(loadRecentProjects);
  const [projectName, setProjectName] = useState("Untitled research");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance);
  const [buildPreferences, setBuildPreferences] = useState<BuildPreferences>(loadBuildPreferences);
  const [systemPrompt, setSystemPrompt] = useState(loadSystemPrompt);
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([]);
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [subscriptions, setSubscriptions] = useState<SubscriptionStatus[]>([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [subscriptionNotice, setSubscriptionNotice] = useState("");
  const [apiProvider, setApiProvider] = useState<"openai" | "anthropic">("openai");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, boolean>>({});
  const saveTimer = useRef<number | null>(null);
  const automaticBuildPending = useRef(false);
  const buildingRef = useRef(false);
  const buildQueued = useRef(false);
  const chatEnd = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const agentMentions = useMemo(
    () => buildAgentMentions(project?.files ?? [], papers),
    [papers, project?.files],
  );

  const rememberProject = useCallback((snapshot: ProjectSnapshot) => {
    setRecentProjects((items) => {
      const next = [
        { name: snapshot.manifest.name, path: snapshot.root },
        ...items.filter((item) => item.path !== snapshot.root),
      ].slice(0, 8);
      persistRecentProjects(next);
      return next;
    });
  }, []);

  const refreshHistory = useCallback(async () => {
    if (!project) return;
    setHistory(await invoke<HistoryItem[]>("list_history"));
  }, [project]);

  const refreshProject = useCallback(async () => {
    const snapshot = await invoke<ProjectSnapshot>("refresh_project");
    setProject(snapshot);
    const [nextPapers, nextCitationKeys] = await Promise.all([
      invoke<PaperSummary[]>("list_papers"),
      invoke<string[]>("list_citation_keys"),
    ]);
    setPapers(nextPapers);
    setCitationKeys(nextCitationKeys);
    return snapshot;
  }, []);

  const loadFile = useCallback(async (path: string) => {
    try {
      const content = await invoke<string>("read_project_file", { path });
      setActiveFile(path);
      setSource(content);
      setSavedSource(content);
      setActivePaper(null);
      setActiveAsset(null);
      setPaperMarkdown("");
      setCanvasMode((mode) => (mode === "paper" || mode === "asset" ? "split" : mode));
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

  const revealPdfSource = useCallback(async (page: number, x: number, y: number) => {
    try {
      const target = await invoke<SyncTexTarget>("synctex_edit", { page, x, y });
      await loadFile(target.path);
      setCanvasMode("split");
      setEditorNavigation({ ...target, id: crypto.randomUUID() });
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [loadFile]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!project || !activeFile || source === savedSource) return true;
    try {
      await invoke("write_project_file", { path: activeFile, content: source });
      setSavedSource(source);
      if (activeFile === project.manifest.primaryBibliography) {
        setCitationKeys(await invoke<string[]>("list_citation_keys"));
      }
      await refreshHistory();
      return true;
    } catch (reason) {
      setError(toMessage(reason));
      return false;
    }
  }, [activeFile, project, refreshHistory, savedSource, source]);

  const runBuild = useCallback(async () => {
    if (buildingRef.current) {
      buildQueued.current = true;
      return;
    }
    buildingRef.current = true;
    setBuilding(true);
    try {
      do {
        buildQueued.current = false;
        const result = await invoke<BuildResult>("build_project");
        setBuild(result);
        if (result.pdfBase64) {
          const nextUrl = base64PdfUrl(result.pdfBase64);
          setPdfUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return nextUrl;
          });
        }
        if (!result.success) setError(result.diagnostics[0]?.message ?? "LaTeX compilation failed.");
        else setError(null);
      } while (buildQueued.current);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      buildingRef.current = false;
      setBuilding(false);
    }
  }, []);

  const compile = useCallback(async () => {
    if (!project) return;
    await runBuild();
  }, [project, runBuild]);

  const saveAndCompileAutomatically = useCallback(async () => {
    if (automaticBuildPending.current) return;
    automaticBuildPending.current = true;
    try {
      if (await save()) await compile();
    } finally {
      automaticBuildPending.current = false;
    }
  }, [compile, save]);

  const enterProject = useCallback(
    async (snapshot: ProjectSnapshot) => {
      setProject(snapshot);
      void runBuild();
      rememberProject(snapshot);
      setProjectMenuOpen(false);
      setBuild(null);
      setSelection("");
      setActivePaper(null);
      setActiveAsset(null);
      setPaperMarkdown("");
      setCanvasMode("split");
      setPdfUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
      const rootDocument =
        snapshot.manifest.rootDocuments.find((document) => document.isDefault) ??
        snapshot.manifest.rootDocuments[0];
      if (rootDocument) await loadFile(rootDocument.path);
      const [nextPapers, nextCitationKeys] = await Promise.all([
        invoke<PaperSummary[]>("list_papers"),
        invoke<string[]>("list_citation_keys"),
      ]);
      setPapers(nextPapers);
      setCitationKeys(nextCitationKeys);
      setHistory(await invoke<HistoryItem[]>("list_history"));
      let sessionList = await invoke<AgentSessionSummary[]>("list_agent_sessions");
      const session = sessionList.length
        ? await invoke<AgentSession>("read_agent_session", { sessionId: sessionList[0].id })
        : await invoke<AgentSession>("create_agent_session", {
          provider: "codex",
          model: defaultModel("codex"),
          reasoningEffort: "high",
        });
      if (!sessionList.length) sessionList = await invoke<AgentSessionSummary[]>("list_agent_sessions");
      setAgentSessions(sessionList);
      setActiveSession(session);
      setMessages(session.messages);
      setBranchSource(null);
      setProvider(session.provider);
      setAgentModel(normalizeModel(session.provider, session.model));
      setReasoningEffort(normalizeEffort(session.reasoningEffort));
      setSessionMenuOpen(false);
      requestAnimationFrame(() => {
        if (shellRef.current) {
          gsap.fromTo(shellRef.current, { opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power2.out" });
        }
      });
    },
    [loadFile, rememberProject, runBuild],
  );

  const chooseExisting = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Open a LaTeX project" });
    if (!selected) return;
    setBusyLabel("Opening project…");
    try {
      if (!(await save())) return;
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path: selected }));
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [enterProject, save]);

  const createProject = useCallback(async () => {
    if (!projectName.trim()) {
      setCreateError("Enter a project name.");
      return;
    }
    const parent = await open({ directory: true, multiple: false, title: "Choose where to create the project" });
    if (!parent) return;
    setBusyLabel("Creating project…");
    try {
      if (!(await save())) return;
      const snapshot = await invoke<ProjectSnapshot>("create_project", { parent, name: projectName });
      setCreateError(null);
      setCreateOpen(false);
      await enterProject(snapshot);
    } catch (reason) {
      setCreateError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [enterProject, projectName, save]);

  const chooseRecentProject = useCallback(async (path: string) => {
    if (path === project?.root) {
      setProjectMenuOpen(false);
      return;
    }
    if (!(await save())) return;
    setBusyLabel("Switching project…");
    try {
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path }));
    } catch (reason) {
      setRecentProjects((items) => {
        const next = items.filter((item) => item.path !== path);
        persistRecentProjects(next);
        return next;
      });
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [enterProject, project?.root, save]);

  useEffect(() => {
    let active = true;
    void invoke<ProjectSnapshot | null>("initial_project")
      .then((snapshot) => {
        if (active && snapshot) return enterProject(snapshot);
      })
      .catch((reason) => active && setError(toMessage(reason)));
    return () => {
      active = false;
    };
  }, [enterProject]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme changes still apply for the current session without storage.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font", appearance.uiFont);
    document.documentElement.style.setProperty("--editor-font", appearance.editorFont);
    document.documentElement.style.setProperty("--editor-font-size", `${appearance.editorFontSize}px`);
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
    } catch {
      // Appearance changes still apply for the current session without storage.
    }
  }, [appearance]);

  useEffect(() => {
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(appearance.interfaceScale))
      .catch(() => {
        // Browser-based tests and previews do not expose native webview zoom.
      });
  }, [appearance.interfaceScale]);

  useEffect(() => {
    try {
      localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify(buildPreferences));
    } catch {
      // Build preferences still apply for the current session without storage.
    }
  }, [buildPreferences]);

  useEffect(() => {
    try {
      localStorage.setItem(AGENT_SYSTEM_PROMPT_KEY, systemPrompt);
    } catch {
      // The prompt still applies for the current session without storage.
    }
  }, [systemPrompt]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    if (typeof appWindow.isFullscreen !== "function" || typeof appWindow.onResized !== "function") return;
    let active = true;
    let stopListening: (() => void) | undefined;
    const refresh = () => {
      void appWindow.isFullscreen().then((value) => active && setIsFullscreen(value));
    };
    refresh();
    void appWindow.onResized(refresh).then((unlisten) => {
      if (active) stopListening = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, agentRunning]);

  useEffect(() => {
    if (!project || !activeFile || source === savedSource) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const automatic = buildPreferences.autoBuildMode === "automatic";
    const delay = automatic ? 1_200 : 900;
    saveTimer.current = window.setTimeout(() => {
      if (automatic) void saveAndCompileAutomatically();
      else void save();
    }, delay);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [activeFile, buildPreferences.autoBuildMode, project, save, saveAndCompileAutomatically, savedSource, source]);

  const buildWhenLeavingEditor = useCallback(() => {
    if (buildPreferences.autoBuildMode !== "automatic" || source === savedSource) return;
    void saveAndCompileAutomatically();
  }, [buildPreferences.autoBuildMode, saveAndCompileAutomatically, savedSource, source]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save().then((saved) => {
          if (saved) void compile();
        });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseExisting();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [chooseExisting, compile, save]);

  const importPaper = useCallback(async () => {
    if (!importInput.trim()) return;
    setImporting(true);
    try {
      const result = await invoke<{ arxivId: string; title: string; citationKey?: string; alreadyImported: boolean }>("import_arxiv", {
        input: importInput,
      });
      setImportInput("");
      await refreshProject();
      await refreshHistory();
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: result.alreadyImported
            ? `“${result.title}” is already in Papers${result.citationKey ? ` as \\cite{${result.citationKey}}` : ""}.`
            : `Imported “${result.title}”${result.citationKey ? ` as \\cite{${result.citationKey}}` : ""}.`,
        },
      ]);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setImporting(false);
    }
  }, [importInput, refreshHistory, refreshProject]);

  const openPaper = useCallback(async (paper: PaperSummary) => {
    try {
      setPaperMarkdown(await invoke<string>("read_paper", { arxivId: paper.arxivId }));
      setActivePaper(paper);
      setActiveAsset(null);
      setCanvasMode("paper");
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

  const openProjectAsset = useCallback(async (path: string) => {
    try {
      const asset = await invoke<AssetPreview>("read_project_asset", { path });
      setActiveAsset(asset);
      setActivePaper(null);
      setPaperMarkdown("");
      setCanvasMode("asset");
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

  const openProjectAssetFromClick = useCallback((path: string) => {
    if (suppressedFigureClick.current === path) {
      suppressedFigureClick.current = null;
      return;
    }
    void openProjectAsset(path);
  }, [openProjectAsset]);

  const beginProjectFigureDrag = useCallback((path: string, label: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const editorAt = (clientX: number, clientY: number) =>
      Boolean((document.elementFromPoint(clientX, clientY) as Element | null)?.closest(".source-editor"));
    const move = (pointerEvent: PointerEvent) => {
      if (!dragging && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
      dragging = true;
      const overEditor = editorAt(pointerEvent.clientX, pointerEvent.clientY);
      setNativeEditorDropActive(overEditor);
      setFigurePointerDrag({
        path,
        label,
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY,
        overEditor,
      });
    };
    const finish = (pointerEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      setNativeEditorDropActive(false);
      setFigurePointerDrag(null);
      if (!dragging) return;
      suppressedFigureClick.current = path;
      window.setTimeout(() => {
        if (suppressedFigureClick.current === path) suppressedFigureClick.current = null;
      }, 0);
      if (!editorAt(pointerEvent.clientX, pointerEvent.clientY)) return;
      setFigureDropRequest({
        id: crypto.randomUUID(),
        paths: [path],
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY,
      });
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      setNativeEditorDropActive(false);
      setFigurePointerDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }, []);

  const openDocumentMode = useCallback((mode: "source" | "split" | "pdf") => {
    setActiveAsset(null);
    setActivePaper(null);
    setPaperMarkdown("");
    setCanvasMode(mode);
  }, []);

  const createProjectEntry = useCallback(async (path: string, kind: "file" | "folder") => {
    try {
      const createdPath = await invoke<string>("create_project_entry", { path, kind });
      await refreshProject();
      await refreshHistory();
      if (kind === "file") await loadFile(createdPath);
    } catch (reason) {
      setError(toMessage(reason));
      throw reason;
    }
  }, [loadFile, refreshHistory, refreshProject]);

  const importProjectAssets = useCallback(async (paths: string[], targetDirectory = "figures"): Promise<string[]> => {
    if (!paths.length || assetImporting) return [];
    setAssetImporting(true);
    try {
      const imported = await invoke<string[]>("import_project_assets", { paths, targetDirectory });
      await refreshProject();
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: `Imported ${imported.length} figure${imported.length === 1 ? "" : "s"} into ${targetDirectory}.`,
          files: imported,
        },
      ]);
      setError(null);
      return imported;
    } catch (reason) {
      setError(toMessage(reason));
      return [];
    } finally {
      setAssetImporting(false);
      setAssetDropTarget(null);
    }
  }, [assetImporting, refreshProject]);

  const chooseProjectAssets = useCallback(async (targetDirectory = "figures") => {
    const selected = await open({
      multiple: true,
      title: `Import figures into ${targetDirectory}`,
      filters: [{ name: "Figures", extensions: ["png", "jpg", "jpeg", "pdf", "svg", "eps", "webp"] }],
    });
    if (!selected) return;
    await importProjectAssets(Array.isArray(selected) ? selected : [selected], targetDirectory);
  }, [importProjectAssets]);

  useEffect(() => {
    if (!project) return;
    let dispose: (() => void) | undefined;
    let active = true;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (!active) return;
        if (event.payload.type === "leave") {
          setAssetDropTarget(null);
          setNativeEditorDropActive(false);
          return;
        }
        const editorPosition = dropEditorAt(event.payload.position);
        const targetDirectory = dropDirectoryAt(event.payload.position);
        setAssetDropTarget(targetDirectory);
        setNativeEditorDropActive(Boolean(editorPosition));
        if (event.payload.type === "drop") {
          setAssetDropTarget(null);
          setNativeEditorDropActive(false);
          if (!event.payload.paths.length) return;
          if (editorPosition) {
            void importProjectAssets(event.payload.paths, "figures").then((paths) => {
              if (paths.length) {
                setFigureDropRequest({
                  id: crypto.randomUUID(),
                  paths,
                  clientX: editorPosition.x,
                  clientY: editorPosition.y,
                });
              }
            });
          } else if (targetDirectory) void importProjectAssets(event.payload.paths, targetDirectory);
          else setError("Drop image files onto a project folder or anywhere in the Project pane to add them to figures.");
        }
      }))
      .then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      })
      .catch(() => {
        // Browser-based tests and previews do not expose native file paths.
      });
    return () => {
      active = false;
      dispose?.();
    };
  }, [importProjectAssets, project]);

  const prepareLatexFigure = useCallback(async (path: string): Promise<string | null> => {
    try {
      const prepared = await invoke<string>("prepare_latex_figure", { path });
      if (prepared !== path) await refreshProject();
      setError(null);
      return prepared;
    } catch (reason) {
      setError(toMessage(reason));
      return null;
    }
  }, [refreshProject]);

  const handleFigureDropHandled = useCallback((id: string) => {
    setFigureDropRequest((request) => request?.id === id ? null : request);
  }, []);

  const handleEditorNavigationHandled = useCallback((id: string) => {
    setEditorNavigation((request) => request?.id === id ? null : request);
  }, []);

  const deleteProjectEntry = useCallback(async (path: string) => {
    if (!window.confirm(`Delete “${path}” from this project?`)) return;
    try {
      await invoke("delete_project_entry", { path });
      const snapshot = await refreshProject();
      await refreshHistory();
      if (activeFile === path || activeFile.startsWith(`${path}/`)) {
        const rootDocument = snapshot.manifest.rootDocuments.find((document) => document.isDefault)
          ?? snapshot.manifest.rootDocuments[0];
        if (rootDocument) await loadFile(rootDocument.path);
      } else if (activeAsset?.path === path || activeAsset?.path.startsWith(`${path}/`)) {
        setActiveAsset(null);
        setCanvasMode("split");
      }
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeAsset, activeFile, loadFile, refreshHistory, refreshProject]);

  const renameProjectEntry = useCallback((path: string, name: string) => {
    setRenameError(null);
    setRenameTarget({ kind: "entry", path, name });
  }, []);

  const renameImportedPaper = useCallback((paper: PaperSummary) => {
    setRenameError(null);
    setRenameTarget({ kind: "paper", paper });
  }, []);

  const submitRename = useCallback(async (name: string) => {
    if (!renameTarget) return;
    try {
      if (renameTarget.kind === "entry") {
        const renamedPath = await invoke<string>("rename_project_entry", {
          path: renameTarget.path,
          newName: name,
        });
        await refreshProject();
        const renamedActiveFile = activeFile === renameTarget.path
          ? renamedPath
          : activeFile.startsWith(`${renameTarget.path}/`)
            ? `${renamedPath}${activeFile.slice(renameTarget.path.length)}`
            : null;
        const renamedActiveAsset = activeAsset?.path === renameTarget.path
          ? renamedPath
          : activeAsset?.path.startsWith(`${renameTarget.path}/`)
            ? `${renamedPath}${activeAsset.path.slice(renameTarget.path.length)}`
            : null;
        if (renamedActiveFile) await loadFile(renamedActiveFile);
        if (renamedActiveAsset) await openProjectAsset(renamedActiveAsset);
      } else {
        const renamedPaper = await invoke<PaperSummary>("rename_paper", {
          arxivId: renameTarget.paper.arxivId,
          title: name,
        });
        await refreshProject();
        if (activePaper?.arxivId === renamedPaper.arxivId) setActivePaper(renamedPaper);
      }
      setRenameError(null);
      setRenameTarget(null);
    } catch (reason) {
      setRenameError(toMessage(reason));
    }
  }, [activeAsset, activeFile, activePaper, loadFile, openProjectAsset, refreshProject, renameTarget]);

  const revealProjectItem = useCallback(async (relativePath: string) => {
    if (!project) return;
    try {
      await revealItemInDir(projectItemPath(project.root, relativePath));
      setError(null);
    } catch (reason) {
      setError(`Could not show that item in Finder. ${toMessage(reason)}`);
    }
  }, [project]);

  const deletePaper = useCallback(async (paper: PaperSummary) => {
    if (!window.confirm(`Remove “${paper.title}” and its bibliography entry?`)) return;
    try {
      await invoke("delete_paper", { arxivId: paper.arxivId });
      if (activePaper?.arxivId === paper.arxivId) {
        setActivePaper(null);
        setPaperMarkdown("");
        setCanvasMode("split");
      }
      await refreshProject();
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activePaper, refreshHistory, refreshProject]);

  const changeProvider = useCallback((nextProvider: AgentProvider) => {
    setProvider(nextProvider);
    setAgentModel(defaultModel(nextProvider));
    setReasoningEffort("high");
  }, []);

  const refreshAgentSessions = useCallback(async () => {
    setAgentSessions(await invoke<AgentSessionSummary[]>("list_agent_sessions"));
  }, []);

  const newAgentSession = useCallback(async () => {
    if (agentRunning) return;
    try {
      const session = await invoke<AgentSession>("create_agent_session", {
        provider,
        model: agentModel,
        reasoningEffort,
      });
      setActiveSession(session);
      setMessages(session.messages);
      setBranchSource(null);
      setSessionMenuOpen(false);
      await refreshAgentSessions();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [agentModel, agentRunning, provider, reasoningEffort, refreshAgentSessions]);

  const openAgentSession = useCallback(async (id: string) => {
    if (agentRunning || id === activeSession?.id) {
      setSessionMenuOpen(false);
      return;
    }
    try {
      const session = await invoke<AgentSession>("read_agent_session", { sessionId: id });
      setActiveSession(session);
      setMessages(session.messages);
      setBranchSource(null);
      setProvider(session.provider);
      setAgentModel(normalizeModel(session.provider, session.model));
      setReasoningEffort(normalizeEffort(session.reasoningEffort));
      setSessionMenuOpen(false);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeSession?.id, agentRunning]);

  const deleteAgentSession = useCallback(async (id: string) => {
    if (agentRunning) return;
    try {
      await invoke("delete_agent_session", { sessionId: id });
      let remaining = await invoke<AgentSessionSummary[]>("list_agent_sessions");
      if (id === activeSession?.id) {
        const next = remaining.length
          ? await invoke<AgentSession>("read_agent_session", { sessionId: remaining[0].id })
          : await invoke<AgentSession>("create_agent_session", { provider, model: agentModel, reasoningEffort });
        if (!remaining.length) remaining = await invoke<AgentSessionSummary[]>("list_agent_sessions");
        setActiveSession(next);
        setMessages(next.messages);
        setProvider(next.provider);
        setAgentModel(normalizeModel(next.provider, next.model));
        setReasoningEffort(normalizeEffort(next.reasoningEffort));
      }
      setAgentSessions(remaining);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeSession, agentModel, agentRunning, provider, reasoningEffort]);

  const sendToAgent = useCallback(async () => {
    const message = agentInput.trim();
    if (!message || agentRunning) return;
    setAgentInput("");
    setAgentRunning(true);
    setAgentStreaming(false);
    setAgentStatus(branchSource ? "Creating conversation branch…" : "Reading project context…");
    let session = activeSession;
    let currentMessages = messages;
    const streamedMessageId = crypto.randomUUID();
    try {
      if (!(await save())) throw new Error("Save the current file before running the agent.");
      if (branchSource) {
        session = await invoke<AgentSession>("fork_agent_session", {
          sourceSessionId: branchSource.sessionId,
          messageId: branchSource.messageId,
          systemPrompt,
        });
        setBranchSource(null);
        setProvider(session.provider);
        setAgentModel(normalizeModel(session.provider, session.model));
        setReasoningEffort(normalizeEffort(session.reasoningEffort));
        currentMessages = session.messages;
        setMessages(session.messages);
        setSelection("");
        await refreshProject();
        await refreshHistory();
        if (activeFile) await loadFile(activeFile);
        await compile();
      } else if (!session) session = await invoke<AgentSession>("create_agent_session", {
        provider,
        model: agentModel,
        reasoningEffort,
      });
      const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", text: message };
      await invoke("save_agent_checkpoint", { sessionId: session.id, messageId: userMessage.id });
      const pendingMessages = [...session.messages, userMessage];
      currentMessages = pendingMessages;
      setMessages(pendingMessages);
      const onEvent = new Channel<AgentStreamEvent>((event) => {
        if (event.type === "status") {
          setAgentStatus(event.message);
          return;
        }
        if (!event.text) return;
        const streamedMessages: ChatMessage[] = [...pendingMessages, {
          id: streamedMessageId,
          role: "agent",
          text: event.text,
        }];
        currentMessages = streamedMessages;
        setAgentStreaming(true);
        setAgentStatus("");
        setMessages(streamedMessages);
      });
      session = await invoke<AgentSession>("save_agent_session", {
        session: { ...session, provider, model: agentModel, reasoningEffort, messages: pendingMessages },
      });
      setActiveSession(session);
      await refreshAgentSessions();
      const result = await invoke<AgentResult>("run_agent", {
        onEvent,
        request: {
          settings: { provider, model: agentModel, reasoningEffort },
          message,
          activeFile: activeFile || null,
          selection: selection || null,
          sessionId: session.id,
          sessionTitle: session.title,
          systemPrompt,
        },
      });
      const completedMessages: ChatMessage[] = [...pendingMessages, {
        id: streamedMessageId,
        role: "agent",
        text: result.summary,
        files: result.changedFiles,
        skills: result.skillsUsed ?? [],
      }];
      currentMessages = completedMessages;
      setAgentStreaming(false);
      setAgentStatus("");
      setMessages(completedMessages);
      session = await invoke<AgentSession>("save_agent_session", {
        session: { ...session, provider, model: agentModel, reasoningEffort, messages: completedMessages },
      });
      setActiveSession(session);
      await refreshAgentSessions();
      if (activeFile && result.changedFiles.includes(activeFile)) await loadFile(activeFile);
      await refreshProject();
      await refreshHistory();
      if (result.changedFiles.length) await compile();
    } catch (reason) {
      const failedMessages: ChatMessage[] = [
        ...currentMessages,
        { id: crypto.randomUUID(), role: "system", text: toMessage(reason) },
      ];
      setMessages(failedMessages);
      if (session) {
        try {
          const saved = await invoke<AgentSession>("save_agent_session", {
            session: { ...session, provider, model: agentModel, reasoningEffort, messages: failedMessages },
          });
          setActiveSession(saved);
          await refreshAgentSessions();
        } catch {
          // Keep the visible error when persistence also fails.
        }
      }
    } finally {
      setAgentRunning(false);
      setAgentStreaming(false);
      setAgentStatus("");
    }
  }, [activeFile, activeSession, agentInput, agentModel, agentRunning, branchSource, compile, loadFile, messages, provider, reasoningEffort, refreshAgentSessions, refreshHistory, refreshProject, save, selection, systemPrompt]);

  const editAndBranch = useCallback((message: ChatMessage) => {
    if (!activeSession || agentRunning || message.role !== "user") return;
    setBranchSource({ sessionId: activeSession.id, messageId: message.id });
    setAgentInput(message.text);
  }, [activeSession, agentRunning]);

  const revert = useCallback(
    async (id: string) => {
      try {
        await invoke("revert_transaction", { transactionId: id });
        if (activeFile) await loadFile(activeFile);
        await refreshProject();
        await refreshHistory();
        await compile();
      } catch (reason) {
        setError(toMessage(reason));
      }
    },
    [activeFile, compile, loadFile, refreshHistory, refreshProject],
  );

  const refreshApiKeys = useCallback(async () => {
    const statuses = await invoke<[string, boolean][]>("api_key_status");
    setApiKeyStatus(Object.fromEntries(statuses));
  }, []);

  const refreshSubscriptions = useCallback(async () => {
    setSubscriptionsLoading(true);
    try {
      setSubscriptions(await invoke<SubscriptionStatus[]>("subscription_status"));
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setSubscriptionsLoading(false);
    }
  }, []);

  const refreshAgentSkills = useCallback(async () => {
    setAgentSkills(await invoke<AgentSkill[]>("list_agent_skills"));
  }, []);

  const saveAgentSkill = useCallback(async (draft: SkillDraft) => {
    try {
      await invoke("save_agent_skill", {
        request: { originalName: draft.originalName ?? null, scope: draft.scope, content: draft.content },
      });
      setSkillDraft(null);
      await refreshAgentSkills();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshAgentSkills]);

  const setAgentSkillEnabled = useCallback(async (name: string, enabled: boolean) => {
    try {
      await invoke("set_agent_skill_enabled", { name, enabled });
      await refreshAgentSkills();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshAgentSkills]);

  const deleteAgentSkill = useCallback(async (skill: AgentSkill) => {
    if (!window.confirm(`Delete ${skill.name}?`)) return;
    try {
      await invoke("delete_agent_skill", { name: skill.name, scope: skill.scope });
      await refreshAgentSkills();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshAgentSkills]);

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setSubscriptionNotice("");
    if (tab === "api") void refreshApiKeys().catch((reason) => setError(toMessage(reason)));
    if (tab === "accounts") void refreshSubscriptions();
    if (tab === "agent") void refreshAgentSkills().catch((reason) => setError(toMessage(reason)));
  }, [refreshAgentSkills, refreshApiKeys, refreshSubscriptions]);

  const beginSubscriptionLogin = useCallback(async (providerName: "codex" | "claude") => {
    try {
      await invoke("begin_subscription_login", { provider: providerName });
      setSubscriptionNotice(`Complete ${providerName === "codex" ? "Codex" : "Claude"} sign-in in the browser, then refresh status.`);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

  const saveApiKey = useCallback(async () => {
    try {
      await invoke("save_api_key", { provider: apiProvider, key: apiKey });
      setApiKey("");
      await refreshApiKeys();
      changeProvider(apiProvider === "openai" ? "openai-api" : "anthropic-api");
      setSettingsOpen(false);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [apiKey, apiProvider, changeProvider, refreshApiKeys]);

  const deleteApiKey = useCallback(async () => {
    try {
      await invoke("delete_api_key", { provider: apiProvider });
      setApiKey("");
      await refreshApiKeys();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [apiProvider, refreshApiKeys]);

  const deleteHistory = useCallback(async (id: string) => {
    try {
      await invoke("delete_history_entry", { transactionId: id });
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshHistory]);

  const beginPanelResize = useCallback((panel: PanelKind, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = panelWidths;
    let latest = panelWidths;
    document.body.classList.add("resizing-panels");
    const handleMove = (moveEvent: PointerEvent) => {
      latest = resizePanelWidths(panel, startWidths, moveEvent.clientX - startX, navigatorOpen);
      setPanelWidths(latest);
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      persistPanelWidths(latest);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }, [navigatorOpen, panelWidths]);

  const nudgePanel = useCallback((panel: PanelKind, delta: number) => {
    setPanelWidths((current) => {
      const next = resizePanelWidths(panel, current, delta, navigatorOpen);
      persistPanelWidths(next);
      return next;
    });
  }, [navigatorOpen]);

  const settingsDialog = settingsOpen ? (
    <SettingsDialog
      tab={settingsTab}
      setTab={(tab) => {
        setSettingsTab(tab);
        if (tab === "api") void refreshApiKeys().catch((reason) => setError(toMessage(reason)));
        if (tab === "accounts") void refreshSubscriptions();
        if (tab === "agent") void refreshAgentSkills().catch((reason) => setError(toMessage(reason)));
      }}
      appearance={appearance}
      setAppearance={setAppearance}
      theme={theme}
      setTheme={setTheme}
      buildPreferences={buildPreferences}
      setBuildPreferences={setBuildPreferences}
      systemPrompt={systemPrompt}
      setSystemPrompt={setSystemPrompt}
      hasProject={Boolean(project)}
      skills={agentSkills}
      skillDraft={skillDraft}
      setSkillDraft={setSkillDraft}
      onSaveSkill={saveAgentSkill}
      onSetSkillEnabled={setAgentSkillEnabled}
      onDeleteSkill={deleteAgentSkill}
      subscriptions={subscriptions}
      subscriptionsLoading={subscriptionsLoading}
      subscriptionNotice={subscriptionNotice}
      onRefreshSubscriptions={refreshSubscriptions}
      onSubscriptionLogin={beginSubscriptionLogin}
      apiProvider={apiProvider}
      setApiProvider={setApiProvider}
      apiKey={apiKey}
      setApiKey={setApiKey}
      apiConfigured={Boolean(apiKeyStatus[apiProvider])}
      onSaveApiKey={saveApiKey}
      onDeleteApiKey={deleteApiKey}
      onClose={() => {
        setSettingsOpen(false);
        setApiKey("");
      }}
    />
  ) : null;

  if (!project) {
    return (
      <>
        <Welcome
          busyLabel={busyLabel}
          createOpen={createOpen}
          error={error}
          createError={createError}
          projectName={projectName}
          onOpenCreate={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
          onCloseCreate={() => {
            setCreateError(null);
            setCreateOpen(false);
          }}
          setProjectName={(value) => {
            setProjectName(value);
            setCreateError(null);
          }}
          onCreate={createProject}
          onOpen={chooseExisting}
          onSettings={() => openSettings("appearance")}
        />
        {settingsDialog}
      </>
    );
  }

  return (
    <div className={`app-shell ${isFullscreen ? "fullscreen" : ""}`} ref={shellRef}>
      <header className="titlebar" onMouseDown={beginWindowDrag}>
        <div className="titlebar-navigator">
          <div className="traffic-space" />
          <button className="icon-button" onClick={() => setNavigatorOpen((value) => !value)} title={navigatorOpen ? "Hide navigator" : "Show navigator"}>
            <span key={navigatorOpen ? "open" : "closed"} className="toggle-icon">
              {navigatorOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </span>
          </button>
        </div>
        <div className="project-switcher">
          <button
            className="project-title"
            aria-label="Switch project"
            aria-expanded={projectMenuOpen}
            disabled={agentRunning || building || importing}
            onClick={() => setProjectMenuOpen((value) => !value)}
          >
            <span>{project.manifest.name}</span>
            <ChevronDown size={13} />
          </button>
          <div className="titlebar-drag-area" aria-hidden="true" />
          {projectMenuOpen && (
            <ProjectMenu
              currentPath={project.root}
              recentProjects={recentProjects}
              busyLabel={busyLabel}
              onRecent={chooseRecentProject}
              onOpen={() => {
                setProjectMenuOpen(false);
                void chooseExisting();
              }}
              onNew={() => {
                setProjectMenuOpen(false);
                setCreateError(null);
                setCreateOpen(true);
              }}
              onClose={() => setProjectMenuOpen(false)}
            />
          )}
        </div>
        <div className="title-actions">
          <button className="icon-button" onClick={() => openSettings("appearance")} title="Settings">
            <Settings2 size={16} />
          </button>
          <button className={`build-button ${build?.success ? "success" : ""}`} title={autoBuildDescription(buildPreferences.autoBuildMode)} onClick={compile} disabled={building} aria-live="polite">
            {building ? <LoaderCircle className="spin" size={15} /> : build?.success ? <Check size={15} /> : <Play size={15} />}
            {building ? "Building" : build?.success ? `${(build.durationMs / 1000).toFixed(1)}s` : "Build"}
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <CircleAlert size={15} />
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={14} /></button>
        </div>
      )}

      <main
        className={`workspace ${navigatorOpen ? "" : "navigator-hidden"}`}
        style={{
          gridTemplateColumns: navigatorOpen
            ? `${panelWidths.navigator}px 5px ${panelWidths.agent}px 5px minmax(360px, 1fr)`
            : `${panelWidths.agent}px 5px minmax(360px, 1fr)`,
        }}
      >
        {navigatorOpen && (
          <>
            <Navigator
              files={project.files}
              activeFile={activeAsset || activePaper ? "" : activeFile}
              activeAssetPath={activeAsset?.path ?? ""}
              protectedPaths={[
                ...project.manifest.rootDocuments.map((document) => document.path),
                project.manifest.primaryBibliography,
              ]}
              papers={papers}
              activePaper={activePaper}
              onFile={loadFile}
              onAsset={openProjectAssetFromClick}
              onBeginFigureDrag={beginProjectFigureDrag}
              onCreateEntry={createProjectEntry}
              onDeleteEntry={deleteProjectEntry}
              onRenameEntry={renameProjectEntry}
              onReveal={revealProjectItem}
              onImportAssets={chooseProjectAssets}
              assetDropTarget={assetDropTarget}
              assetImporting={assetImporting}
              onPaper={openPaper}
              onDeletePaper={deletePaper}
              onRenamePaper={renameImportedPaper}
              importInput={importInput}
              setImportInput={setImportInput}
              onImport={importPaper}
              importing={importing}
            />
            <PanelResizer
              label="Resize project navigator"
              value={panelWidths.navigator}
              onPointerDown={(event) => beginPanelResize("navigator", event)}
              onNudge={(delta) => nudgePanel("navigator", delta)}
            />
          </>
        )}

        <AgentPanel
          messages={messages}
          sessions={agentSessions}
          activeSession={activeSession}
          sessionMenuOpen={sessionMenuOpen}
          setSessionMenuOpen={setSessionMenuOpen}
          onNewSession={newAgentSession}
          onOpenSession={openAgentSession}
          onDeleteSession={deleteAgentSession}
          onEditMessage={editAndBranch}
          input={agentInput}
          setInput={setAgentInput}
          provider={provider}
          setProvider={changeProvider}
          model={agentModel}
          setModel={setAgentModel}
          reasoningEffort={reasoningEffort}
          setReasoningEffort={setReasoningEffort}
          running={agentRunning}
          streaming={agentStreaming}
          status={agentStatus}
          onSend={sendToAgent}
          onApiSettings={() => openSettings("api")}
          selection={selection}
          branchSource={branchSource}
          onCancelBranch={() => setBranchSource(null)}
          mentions={agentMentions}
          chatEnd={chatEnd}
        />

        <PanelResizer
          label="Resize writing agent"
          value={panelWidths.agent}
          onPointerDown={(event) => beginPanelResize("agent", event)}
          onNudge={(delta) => nudgePanel("agent", delta)}
        />

        <section className="canvas-panel">
          <CanvasToolbar
            mode={canvasMode}
            setMode={openDocumentMode}
            activePath={activeAsset?.path ?? activePaper?.title ?? activeFile}
            activeKind={activeAsset ? "asset" : activePaper ? "paper" : "document"}
            dirty={source !== savedSource}
            onHistory={() => setHistoryOpen(true)}
          />
          <DocumentCanvas
            mode={canvasMode}
            source={source}
            activeFile={activeFile}
            setSource={setSource}
            setSelection={setSelection}
            pdfUrl={pdfUrl}
            pdfBase64={build?.pdfBase64 ?? null}
            paperMarkdown={paperMarkdown}
            activePaper={activePaper}
            activeAsset={activeAsset}
            citationKeys={citationKeys}
            onEditorLeave={buildWhenLeavingEditor}
            onPrepareFigure={prepareLatexFigure}
            nativeFigureDropActive={nativeEditorDropActive}
            figurePointerPosition={figurePointerDrag?.overEditor ? {
              x: figurePointerDrag.clientX,
              y: figurePointerDrag.clientY,
            } : null}
            figureDropRequest={figureDropRequest}
            onFigureDropHandled={handleFigureDropHandled}
            editorNavigation={editorNavigation}
            onEditorNavigationHandled={handleEditorNavigationHandled}
            onPdfSource={revealPdfSource}
          />
        </section>
      </main>

      {figurePointerDrag && (
        <div
          className={`figure-drag-ghost ${figurePointerDrag.overEditor ? "ready" : ""}`}
          style={{ left: figurePointerDrag.clientX + 12, top: figurePointerDrag.clientY + 12 }}
        >
          <Image size={13} />
          <span>{figurePointerDrag.label}</span>
        </div>
      )}

      {historyOpen && (
        <HistoryDrawer history={history} onClose={() => setHistoryOpen(false)} onRevert={revert} onDelete={deleteHistory} />
      )}
      {settingsDialog}
      {createOpen && (
        <CreateProjectDialog
          projectName={projectName}
          setProjectName={(value) => {
            setProjectName(value);
            setCreateError(null);
          }}
          error={createError}
          onCreate={createProject}
          onClose={() => {
            setCreateError(null);
            setCreateOpen(false);
          }}
        />
      )}
      {renameTarget && (
        <RenameDialog
          target={renameTarget}
          error={renameError}
          onRename={submitRename}
          onClose={() => {
            setRenameError(null);
            setRenameTarget(null);
          }}
        />
      )}
    </div>
  );
}

function Welcome(props: {
  busyLabel: string | null;
  createOpen: boolean;
  error: string | null;
  createError: string | null;
  projectName: string;
  onOpenCreate: () => void;
  onCloseCreate: () => void;
  setProjectName: (value: string) => void;
  onCreate: () => void;
  onOpen: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="welcome-screen">
      <div className="welcome-titlebar" onMouseDown={beginWindowDrag}>
        <button className="icon-button" onClick={props.onSettings} title="Settings"><Settings2 size={16} /></button>
      </div>
      <div className="welcome-glow" />
      <div className="welcome-content">
        <div className="brand-mark"><Sparkles size={24} /></div>
        <p className="eyebrow">LATTICE</p>
        <h1>Research, written with evidence.</h1>
        <p className="welcome-copy">
          A local-first LaTeX workspace where your writing agent, sources, manuscript, and rendered paper stay connected.
        </p>
        <div className="welcome-actions">
          <button className="primary-button" onClick={props.onOpenCreate}>
            <Plus size={17} /> New project
          </button>
          <button className="secondary-button" onClick={props.onOpen}>
            <FolderOpen size={17} /> Open folder
          </button>
        </div>
        {props.busyLabel && <p className="busy-label"><LoaderCircle className="spin" size={15} /> {props.busyLabel}</p>}
        {props.error && <p className="welcome-error">{props.error}</p>}
      </div>
      {props.createOpen && <CreateProjectDialog projectName={props.projectName} setProjectName={props.setProjectName} error={props.createError} onCreate={props.onCreate} onClose={props.onCloseCreate} />}
    </div>
  );
}

function CreateProjectDialog(props: {
  projectName: string;
  setProjectName: (value: string) => void;
  error: string | null;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><FileText size={20} /></div>
        <h2>Create a research project</h2>
        <p>Lattice will create a concise NeurIPS 2026 preprint, bibliography, project brief, and private conversation history.</p>
        <label>
          Project name
          <input autoFocus value={props.projectName} onChange={(event) => props.setProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onCreate()} />
        </label>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <button className="primary-button" onClick={props.onCreate}>Choose location</button>
        </div>
      </div>
    </div>
  );
}

function RenameDialog(props: {
  target: RenameTarget;
  error: string | null;
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const initialName = props.target.kind === "entry" ? props.target.name : props.target.paper.title;
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    await props.onRename(name.trim());
    setBusy(false);
  };
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal rename-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><Pencil size={19} /></div>
        <h2>{props.target.kind === "paper" ? "Rename paper" : "Rename project item"}</h2>
        <p>{props.target.kind === "paper" ? "This changes the title shown in Papers. The citation key stays unchanged." : "Use a simple name. Existing file extensions are kept when omitted."}</p>
        <label>
          Name
          <input
            autoFocus
            aria-label="New name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") props.onClose();
            }}
          />
        </label>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? "Renaming…" : "Rename"}</button>
        </div>
      </div>
    </div>
  );
}

function ProjectMenu(props: {
  currentPath: string;
  recentProjects: RecentProject[];
  busyLabel: string | null;
  onRecent: (path: string) => void;
  onOpen: () => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const alternatives = props.recentProjects.filter((item) => item.path !== props.currentPath);
  return (
    <>
      <button className="project-menu-dismiss" aria-label="Close project menu" onClick={props.onClose} />
      <div className="project-menu">
        <div className="project-menu-heading">Recent projects</div>
        <div className="recent-projects">
          {alternatives.map((item) => (
            <button key={item.path} onClick={() => props.onRecent(item.path)} disabled={Boolean(props.busyLabel)}>
              <span className="recent-project-icon"><Folder size={14} /></span>
              <span><strong>{item.name}</strong><small>{item.path}</small></span>
            </button>
          ))}
          {!alternatives.length && <p>No other recent projects yet.</p>}
        </div>
        <div className="project-menu-actions">
          <button onClick={props.onOpen}><FolderOpen size={14} /> Open another folder <kbd>⌘O</kbd></button>
          <button onClick={props.onNew}><Plus size={14} /> New project</button>
        </div>
        {props.busyLabel && <div className="project-menu-busy"><LoaderCircle className="spin" size={13} /> {props.busyLabel}</div>}
      </div>
    </>
  );
}

function PanelResizer(props: {
  label: string;
  value: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(props.value)}
      tabIndex={0}
      onPointerDown={props.onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          props.onNudge(-16);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onNudge(16);
        }
      }}
    />
  );
}

function Navigator(props: {
  files: FileNode[];
  activeFile: string;
  activeAssetPath: string;
  protectedPaths: string[];
  papers: PaperSummary[];
  activePaper: PaperSummary | null;
  onFile: (path: string) => void;
  onAsset: (path: string) => void;
  onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onCreateEntry: (path: string, kind: "file" | "folder") => Promise<void>;
  onDeleteEntry: (path: string) => void;
  onRenameEntry: (path: string, name: string) => void;
  onReveal: (path: string) => void;
  onImportAssets: (targetDirectory?: string) => void;
  assetDropTarget: string | null;
  assetImporting: boolean;
  onPaper: (paper: PaperSummary) => void;
  onDeletePaper: (paper: PaperSummary) => void;
  onRenamePaper: (paper: PaperSummary) => void;
  importInput: string;
  setImportInput: (value: string) => void;
  onImport: () => void;
  importing: boolean;
}) {
  const navigatorRef = useRef<HTMLElement | null>(null);
  const [navigatorSplit, setNavigatorSplit] = useState(loadNavigatorSplit);
  const [entryFormOpen, setEntryFormOpen] = useState(false);
  const [entryPath, setEntryPath] = useState("");
  const [entryKind, setEntryKind] = useState<"file" | "folder">("file");
  const [entryBusy, setEntryBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; label: string; paper?: PaperSummary } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ProjectSearchResult[]>([]);
  const [searchResultQuery, setSearchResultQuery] = useState("");
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setSearching(true);
      void invoke<ProjectSearchResult[]>("search_project", { query })
        .then((results) => {
          if (active) {
            setSearchResults(results);
            setSearchResultQuery(query);
          }
        })
        .catch(() => {
          if (active) {
            setSearchResults([]);
            setSearchResultQuery(query);
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);
  const searchActive = Boolean(searchQuery.trim());
  const searchPending = searchActive && searchResultQuery !== searchQuery.trim();
  const visibleSearchResults = searchActive && searchResultQuery === searchQuery.trim() ? searchResults : [];
  const fileSearchResults = visibleSearchResults.filter((result) => result.kind === "file");
  const paperSearchResults = visibleSearchResults.filter((result) => result.kind === "paper");
  const paperResultCount = searchPending ? "…" : paperSearchResults.length;
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [contextMenu]);
  const showContextMenu = (event: React.MouseEvent, path: string, label: string, paper?: PaperSummary) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 202),
      y: Math.min(event.clientY, window.innerHeight - 82),
      path,
      label,
      paper,
    });
  };
  const closeEntryForm = () => {
    if (entryBusy) return;
    setEntryFormOpen(false);
    setEntryPath("");
  };
  const submitEntry = async () => {
    if (!entryPath.trim() || entryBusy) return;
    setEntryBusy(true);
    try {
      await props.onCreateEntry(entryPath.trim(), entryKind);
      setEntryPath("");
      setEntryFormOpen(false);
    } catch {
      // The workspace error banner explains why creation failed.
    } finally {
      setEntryBusy(false);
    }
  };
  const setSplitFromPointer = (clientY: number) => {
    const bounds = navigatorRef.current?.getBoundingClientRect();
    if (!bounds?.height) return navigatorSplit;
    const next = clamp((clientY - bounds.top) / bounds.height, 0.2, 0.78);
    setNavigatorSplit(next);
    return next;
  };
  const beginNavigatorSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    let latest = navigatorSplit;
    document.body.classList.add("resizing-navigator-split");
    const handleMove = (moveEvent: PointerEvent) => {
      latest = setSplitFromPointer(moveEvent.clientY);
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-navigator-split");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      persistNavigatorSplit(latest);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };
  const nudgeNavigatorSplit = (delta: number) => {
    const next = clamp(navigatorSplit + delta, 0.2, 0.78);
    setNavigatorSplit(next);
    persistNavigatorSplit(next);
  };
  return (
    <aside
      ref={navigatorRef}
      className={`navigator ${props.assetDropTarget ? "asset-drag-active" : ""}`}
      style={{ gridTemplateRows: `minmax(100px, ${navigatorSplit}fr) 5px minmax(140px, ${1 - navigatorSplit}fr)` }}
    >
      <div className="navigator-section project-section" onPointerDown={(event) => {
        const target = event.target as Element;
        if (!target.closest(".project-entry-form") && !target.closest(".section-action")) closeEntryForm();
      }}>
        <div className="section-heading" onContextMenu={(event) => showContextMenu(event, "", "Project folder")}>
          <span>Project</span>
          <button className="section-action" title="Add file or folder" aria-label="Add file or folder" onClick={() => setEntryFormOpen((value) => !value)}><FolderPlus size={14} strokeWidth={1.8} /></button>
        </div>
        <label className="navigator-search">
          <Search size={13} />
          <input aria-label="Search project files and papers" placeholder="Search files and papers" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
          {searchPending || searching ? <LoaderCircle className="spin" size={12} /> : searchActive && <button title="Clear search" onClick={() => setSearchQuery("")}><X size={12} /></button>}
        </label>
        {entryFormOpen && (
          <div className="project-entry-form" onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) closeEntryForm();
          }}>
            <select aria-label="Entry type" value={entryKind} onChange={(event) => setEntryKind(event.target.value as "file" | "folder")}>
              <option value="file">LaTeX</option>
              <option value="folder">Folder</option>
            </select>
            <input
              autoFocus
              aria-label="Project-relative path"
              placeholder={entryKind === "file" ? "sections/method" : "figures/results"}
              value={entryPath}
              onChange={(event) => setEntryPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitEntry();
                if (event.key === "Escape") closeEntryForm();
              }}
            />
            <button title="Create" disabled={entryBusy || !entryPath.trim()} onClick={() => void submitEntry()}>
              {entryBusy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
            </button>
          </div>
        )}
        <div className="file-tree">
          {searchActive ? fileSearchResults.map((result) => (
            <button key={result.path} className="navigator-search-result" onClick={() => result.fileKind === "figure" ? props.onAsset(result.path) : props.onFile(result.path)}>
              {result.fileKind === "figure" ? <Image size={13} /> : <FileText size={13} />}
              <span><strong>{result.title}</strong><small>{result.snippet || result.path}</small></span>
            </button>
          )) : props.files.map((node) => <TreeNode key={node.path} node={node} activeFile={props.activeFile} activeAssetPath={props.activeAssetPath} protectedPaths={props.protectedPaths} onFile={props.onFile} onAsset={props.onAsset} onBeginFigureDrag={props.onBeginFigureDrag} onDelete={props.onDeleteEntry} onImportAssets={props.onImportAssets} assetDropTarget={props.assetDropTarget} assetImporting={props.assetImporting} onContextMenu={showContextMenu} />)}
          {searchActive && !searchPending && !searching && !fileSearchResults.length && <p className="search-empty">No matching project files.</p>}
        </div>
      </div>
      <div
        className="navigator-split-resizer"
        role="separator"
        aria-label="Resize Project and Papers"
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={78}
        aria-valuenow={Math.round(navigatorSplit * 100)}
        tabIndex={0}
        onPointerDown={beginNavigatorSplitResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            nudgeNavigatorSplit(-0.03);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            nudgeNavigatorSplit(0.03);
          }
        }}
      />
      <div className="navigator-section papers-section">
        <div className="section-heading">
          <span>Papers</span>
          <span className="count-badge">{searchActive ? paperResultCount : props.papers.length}</span>
        </div>
        <div className="paper-list">
          {(searchActive ? paperSearchResults.map((result) => props.papers.find((paper) => paper.arxivId === result.arxivId)).filter((paper): paper is PaperSummary => Boolean(paper)) : props.papers).map((paper) => (
            <div key={paper.arxivId} className={`paper-row ${props.activePaper?.arxivId === paper.arxivId ? "active" : ""}`} onContextMenu={(event) => showContextMenu(event, `.research/papers/${paper.arxivId}/paper.md`, paper.title, paper)}>
              <button title={paper.title} className="paper-open" onClick={() => props.onPaper(paper)}>
                <BookOpen size={14} />
                <span><strong>{paper.title}</strong><small>{searchActive ? paperSearchResults.find((result) => result.arxivId === paper.arxivId)?.snippet || `arXiv ${paper.arxivId}` : paper.citationKey ? `\\cite{${paper.citationKey}}` : `arXiv ${paper.arxivId}`}</small></span>
              </button>
              <button className="row-delete" title={`Remove ${paper.title}`} onClick={() => props.onDeletePaper(paper)}><Trash2 size={12} /></button>
            </div>
          ))}
          {!searchActive && !props.papers.length && <p className="empty-note">Add an arXiv paper to ground the agent in project evidence.</p>}
          {searchActive && !searchPending && !searching && !paperSearchResults.length && <p className="search-empty">No matching papers.</p>}
        </div>
        <div className="import-box">
          <input
            placeholder="arXiv URL or id"
            value={props.importInput}
            onChange={(event) => props.setImportInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && props.onImport()}
          />
          <button onClick={props.onImport} disabled={props.importing || !props.importInput.trim()} title="Import paper">
            {props.importing ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
          </button>
        </div>
      </div>
      {contextMenu && (
        <div className="file-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {(contextMenu.paper || contextMenu.path) && <button onClick={() => {
            if (contextMenu.paper) props.onRenamePaper(contextMenu.paper);
            else props.onRenameEntry(contextMenu.path, contextMenu.label);
            setContextMenu(null);
          }}><Pencil size={14} /><span>Rename</span></button>}
          <button onClick={() => { props.onReveal(contextMenu.path); setContextMenu(null); }}><FolderOpen size={14} /><span>Show in Finder</span></button>
          <small title={contextMenu.label}>{contextMenu.label}</small>
        </div>
      )}
    </aside>
  );
}

function TreeNode({ node, activeFile, activeAssetPath, protectedPaths, onFile, onAsset, onBeginFigureDrag, onDelete, onImportAssets, assetDropTarget, assetImporting, onContextMenu }: { node: FileNode; activeFile: string; activeAssetPath: string; protectedPaths: string[]; onFile: (path: string) => void; onAsset: (path: string) => void; onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void; onDelete: (path: string) => void; onImportAssets: (targetDirectory?: string) => void; assetDropTarget: string | null; assetImporting: boolean; onContextMenu: (event: React.MouseEvent, path: string, label: string) => void }) {
  const [open, setOpen] = useState(true);
  const protectedEntry = protectedPaths.some((path) => path === node.path || path.startsWith(`${node.path}/`));
  if (node.kind === "directory") {
    return (
      <div className={`tree-directory ${assetDropTarget === node.path ? "drop-target" : ""}`} data-drop-directory={node.path}>
        <div className="tree-row" onContextMenu={(event) => onContextMenu(event, node.path, node.name)}>
          <button className="tree-main" onClick={() => setOpen((value) => !value)}>
            <ChevronRight className={`tree-chevron ${open ? "open" : ""}`} size={13} />
            <Folder size={14} /> <span>{node.name}</span>
          </button>
          {node.path === "figures" && <button className="row-import" title="Import images into figures" disabled={assetImporting} onClick={() => onImportAssets(node.path)}>{assetImporting ? <LoaderCircle className="spin" size={12} /> : <ImagePlus size={12} />}</button>}
          {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
        </div>
        {assetDropTarget === node.path && <div className="asset-drop-hint">Drop images into {node.path}</div>}
        {open && <div className="tree-children">{node.children.map((child) => <TreeNode key={child.path} node={child} activeFile={activeFile} activeAssetPath={activeAssetPath} protectedPaths={protectedPaths} onFile={onFile} onAsset={onAsset} onBeginFigureDrag={onBeginFigureDrag} onDelete={onDelete} onImportAssets={onImportAssets} assetDropTarget={assetDropTarget} assetImporting={assetImporting} onContextMenu={onContextMenu} />)}</div>}
      </div>
    );
  }
  const Icon = node.kind === "tex" ? FileCode2 : node.kind === "bib" ? Library : File;
  if (node.kind === "figure") {
    return (
      <div className={`tree-row asset-row ${activeAssetPath === node.path ? "active" : ""}`} onContextMenu={(event) => onContextMenu(event, node.path, node.name)}>
        <button
          className="tree-main"
          title={`Preview ${node.name}; drag into the LaTeX editor to insert`}
          onClick={() => onAsset(node.path)}
          onPointerDown={(event) => onBeginFigureDrag(node.path, node.name, event)}
        ><span className="tree-spacer" /><Image size={14} /><span>{node.name}</span></button>
        {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
      </div>
    );
  }
  return (
    <div className={`tree-row ${activeFile === node.path ? "active" : ""}`} onContextMenu={(event) => onContextMenu(event, node.path, node.name)}>
      <button className="tree-main" onClick={() => onFile(node.path)}><span className="tree-spacer" /><Icon size={14} /><span>{node.name}</span></button>
      {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
    </div>
  );
}

function AgentPanel({
  messages,
  sessions,
  activeSession,
  sessionMenuOpen,
  setSessionMenuOpen,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onEditMessage,
  input,
  setInput,
  provider,
  setProvider,
  model,
  setModel,
  reasoningEffort,
  setReasoningEffort,
  running,
  streaming,
  status,
  onSend,
  onApiSettings,
  selection,
  branchSource,
  onCancelBranch,
  mentions,
  chatEnd,
}: {
  messages: ChatMessage[];
  sessions: AgentSessionSummary[];
  activeSession: AgentSession | null;
  sessionMenuOpen: boolean;
  setSessionMenuOpen: (value: boolean) => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onEditMessage: (message: ChatMessage) => void;
  input: string;
  setInput: (value: string) => void;
  provider: AgentProvider;
  setProvider: (value: AgentProvider) => void;
  model: string;
  setModel: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  running: boolean;
  streaming: boolean;
  status: string;
  onSend: () => void;
  onApiSettings: () => void;
  selection: string;
  branchSource: { sessionId: string; messageId: string } | null;
  onCancelBranch: () => void;
  mentions: AgentMention[];
  chatEnd: React.RefObject<HTMLDivElement | null>;
}) {
  const options = modelOptions(provider);
  const efforts = options.find((option) => option.value === model)?.efforts ?? ["high"];
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [searchResults, setSearchResults] = useState<AgentSessionSearchResult[] | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const height = clamp(composer.scrollHeight, 44, 160);
    composer.style.height = `${height}px`;
    composer.style.overflowY = composer.scrollHeight > 160 ? "auto" : "hidden";
  }, [input]);
  useEffect(() => {
    if (!sessionMenuOpen) return;
    const closeMenu = () => setSessionMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeMenu);
    };
  }, [sessionMenuOpen, setSessionMenuOpen]);
  useEffect(() => {
    const query = sessionSearch.trim();
    if (!sessionMenuOpen || !query) return;
    const timer = window.setTimeout(() => {
      void invoke<AgentSessionSearchResult[]>("search_agent_sessions", { query })
        .then(setSearchResults)
        .catch(() => setSearchResults([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [sessionMenuOpen, sessionSearch]);
  const visibleSessions: AgentSessionSearchResult[] = sessionSearch.trim() && searchResults
    ? searchResults
    : sessions.map((session) => ({ ...session, snippet: "" }));
  const mentionSuggestions = mention
    ? mentions
      .filter((item) => `${item.label} ${item.path}`.toLowerCase().includes(mention.query.toLowerCase()))
      .slice(0, 8)
    : [];
  const insertMention = (item: AgentMention) => {
    if (!mention) return;
    const inserted = `@${item.path}`;
    const next = `${input.slice(0, mention.start)}${inserted} ${input.slice(mention.end)}`;
    const caret = mention.start + inserted.length + 1;
    setInput(next);
    setMention(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(caret, caret);
    });
  };
  return (
    <section className="agent-panel">
      <div className="agent-header">
        <div className="agent-conversation-controls">
          <button className="agent-title" title="Conversation history" aria-expanded={sessionMenuOpen} onClick={() => setSessionMenuOpen(!sessionMenuOpen)}>
            <Bot size={16} /><span>{compactConversationTitle(activeSession?.title ?? "Writing agent")}</span><ChevronDown size={12} />
          </button>
          <button className="new-conversation-button" title="New conversation" disabled={running} onClick={onNewSession}><Plus size={14} /></button>
        </div>
        <div className="provider-controls">
          <select aria-label="Agent provider" value={provider} disabled={running} onChange={(event) => setProvider(event.target.value as AgentProvider)}>
            <option value="codex">Codex subscription</option>
            <option value="claude">Claude subscription</option>
            <option value="openai-api">OpenAI API</option>
            <option value="anthropic-api">Anthropic API</option>
          </select>
          {(provider === "openai-api" || provider === "anthropic-api") && <button onClick={onApiSettings} title="API key settings"><KeyRound size={14} /></button>}
        </div>
      </div>
      <div className="agent-config-bar">
        <label>
          <span>Model</span>
          <select aria-label="Agent model" value={model} disabled={running} onChange={(event) => {
            const nextModel = event.target.value;
            const nextEfforts = options.find((option) => option.value === nextModel)?.efforts ?? ["high"];
            setModel(nextModel);
            if (!nextEfforts.includes(reasoningEffort)) setReasoningEffort(nextEfforts.includes("high") ? "high" : nextEfforts[0]);
          }}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span>Effort</span>
          <select aria-label="Reasoning effort" value={reasoningEffort} disabled={running} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}>
            {efforts.map((effort) => <option key={effort} value={effort}>{effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1)}</option>)}
          </select>
        </label>
      </div>
      {sessionMenuOpen && (
        <div className="session-menu" onPointerDown={(event) => event.stopPropagation()}>
          <div className="session-menu-heading"><span>Conversations</span><button onClick={onNewSession}><Plus size={13} /> New</button></div>
          <label className="session-search"><Search size={12} /><input aria-label="Search conversations" value={sessionSearch} onChange={(event) => { setSessionSearch(event.target.value); setSearchResults(null); }} placeholder="Search conversations…" /></label>
          <div className="session-list">
            {visibleSessions.map((session) => (
              <div key={session.id} className={session.id === activeSession?.id ? "active" : ""}>
                <button className="session-open" onClick={() => onOpenSession(session.id)}>
                  <strong>{compactConversationTitle(session.title)}</strong>
                  <small>{modelLabel(session.provider, session.model || defaultModel(session.provider))} · {session.messageCount} messages · {relativeTime(session.updatedAt)}</small>
                  {session.snippet && <small className="session-snippet">{session.snippet}</small>}
                </button>
                <button className="session-delete" title="Delete conversation" disabled={running} onClick={() => onDeleteSession(session.id)}><Trash2 size={12} /></button>
              </div>
            ))}
            {!visibleSessions.length && <p className="session-empty">No conversations found.</p>}
          </div>
        </div>
      )}
      <div className="chat-list">
        {messages.map((message, index) => (
          <div key={message.id} className={`chat-message ${message.role} ${streaming && index === messages.length - 1 && message.role === "agent" ? "streaming" : ""}`}>
            {message.role === "agent" && <div className="message-avatar"><Sparkles size={13} /></div>}
            <div className="message-body">
              <p>{message.text}</p>
              {message.role === "user" && <button className="message-edit" title="Edit and branch from this message" disabled={running} onClick={() => onEditMessage(message)}><Pencil size={11} /> Edit</button>}
              {!!message.skills?.length && <div className="skills-used"><small>Skills</small>{message.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>}
              {!!message.files?.length && <div className="changed-files">{message.files.map((file) => <span key={file}><FileCode2 size={11} />{file}</span>)}</div>}
            </div>
          </div>
        ))}
        {running && !streaming && (
          <div className="chat-message agent">
            <div className="message-avatar"><Sparkles size={13} /></div>
            <div className="thinking"><span /><span /><span /><em>{status || (provider === "claude" ? "Claude is writing…" : "Agent is writing…")}</em></div>
          </div>
        )}
        <div ref={chatEnd} />
      </div>
      <div className="composer-wrap">
        {branchSource && <div className="context-chip branch-chip"><Pencil size={11} /> Editing an earlier message creates a new branch <button title="Cancel conversation branch" onClick={onCancelBranch}><X size={11} /></button></div>}
        {selection && <div className="context-chip"><Code2 size={12} /> Selection · {selection.length} chars <button title="Selection follows the editor"><Check size={11} /></button></div>}
        {mention && (
          <div className="mention-menu" role="listbox" aria-label="Project references">
            <div className="mention-heading"><span>Reference project context</span><small>{mentionSuggestions.length ? "↑↓ to navigate · Enter to insert" : "No matches"}</small></div>
            {mentionSuggestions.map((item, index) => (
              <button
                key={item.key}
                role="option"
                aria-selected={index === mentionIndex}
                className={index === mentionIndex ? "active" : ""}
                onMouseDown={(event) => { event.preventDefault(); insertMention(item); }}
              >
                {item.kind === "paper" ? <BookOpen size={13} /> : <FileCode2 size={13} />}
                <span><strong>{item.label}</strong><small>{item.path}</small></span>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <textarea
            ref={composerRef}
            rows={1}
            placeholder="Ask the agent to write, revise, or reason…"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setMention(mentionAtCaret(event.target.value, event.target.selectionStart));
              setMentionIndex(0);
            }}
            onSelect={(event) => setMention(mentionAtCaret(event.currentTarget.value, event.currentTarget.selectionStart))}
            onBlur={() => setMention(null)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") return;
              if (mention && mentionSuggestions.length) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((index) => (index - 1 + mentionSuggestions.length) % mentionSuggestions.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  insertMention(mentionSuggestions[Math.min(mentionIndex, mentionSuggestions.length - 1)]);
                  return;
                }
              }
              if (event.key === "Escape" && mention) {
                event.preventDefault();
                setMention(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                setMention(null);
                onSend();
              }
            }}
          />
          <div className="composer-footer">
            <span>Enter sends · Shift+Enter adds a line</span>
            <button title="Send message" onClick={() => { setMention(null); onSend(); }} disabled={running || !input.trim()}><Send size={14} /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

function buildAgentMentions(files: FileNode[], papers: PaperSummary[]): AgentMention[] {
  const mentions: AgentMention[] = [];
  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.kind === "directory") visit(node.children);
      else mentions.push({ key: `file:${node.path}`, label: node.name, path: node.path, kind: "file" });
    }
  };
  visit(files);
  for (const paper of papers) {
    mentions.push({
      key: `paper:${paper.arxivId}`,
      label: paper.title,
      path: `.research/papers/${paper.arxivId}/paper.md`,
      kind: "paper",
    });
  }
  return mentions;
}

function mentionAtCaret(value: string, caret: number): MentionState | null {
  const beforeCaret = value.slice(0, caret);
  const at = beforeCaret.lastIndexOf("@");
  if (at < 0 || /\s/.test(beforeCaret.slice(at + 1))) return null;
  if (at > 0 && !/\s|[([{"'`]/.test(beforeCaret[at - 1])) return null;
  return { start: at, end: caret, query: beforeCaret.slice(at + 1) };
}

function CanvasToolbar(props: {
  mode: CanvasMode;
  setMode: (mode: "source" | "split" | "pdf") => void;
  activePath: string;
  activeKind: "document" | "paper" | "asset";
  dirty: boolean;
  onHistory: () => void;
}) {
  const ActiveIcon = props.activeKind === "asset" ? Image : props.activeKind === "paper" ? BookOpen : FileCode2;
  return (
    <div className="canvas-toolbar">
      <div className="active-document"><ActiveIcon size={14} /><span>{props.activePath}</span>{props.activeKind === "document" && props.dirty && <i />}</div>
      <div className="view-switcher">
        {(["source", "split", "pdf"] as const).map((mode) => (
          <button key={mode} className={props.mode === mode ? "active" : ""} onClick={() => props.setMode(mode)}>{mode}</button>
        ))}
      </div>
      <button className="history-button" title="Project history" onClick={props.onHistory}>
        <History size={14} />
      </button>
    </div>
  );
}

function DocumentCanvas(props: {
  mode: CanvasMode;
  source: string;
  activeFile: string;
  setSource: (value: string) => void;
  setSelection: (value: string) => void;
  pdfUrl: string | null;
  pdfBase64: string | null;
  paperMarkdown: string;
  activePaper: PaperSummary | null;
  activeAsset: AssetPreview | null;
  citationKeys: string[];
  onEditorLeave: () => void;
  onPrepareFigure: (path: string) => Promise<string | null>;
  nativeFigureDropActive: boolean;
  figurePointerPosition: { x: number; y: number } | null;
  figureDropRequest: FigureDropRequest | null;
  onFigureDropHandled: (id: string) => void;
  editorNavigation: EditorNavigation | null;
  onEditorNavigationHandled: (id: string) => void;
  onPdfSource: (page: number, x: number, y: number) => void;
}) {
  const {
    activeFile,
    editorNavigation,
    figureDropRequest,
    onEditorNavigationHandled,
    onFigureDropHandled,
    onPrepareFigure,
    setSource,
    source: editorSource,
  } = props;
  const splitRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const lastInsertionPositionRef = useRef(0);
  const pendingFigureCursorRef = useRef<number | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSplitRatio);
  const [figureDropActive, setFigureDropActive] = useState(false);
  const [figureDropMarker, setFigureDropMarker] = useState<{ top: number; line: number } | null>(null);
  const paperHtml = useMemo(
    () => DOMPurify.sanitize(marked.parse(props.paperMarkdown, { async: false }) as string),
    [props.paperMarkdown],
  );
  const editorExtensions = useMemo(
    () => [
      latex(latexLanguageOptions),
      ...latexEditorExtensions(props.citationKeys),
    ],
    [props.citationKeys],
  );
  const insertFigures = useCallback(async (paths: string[], coordinates?: { x: number; y: number }) => {
    const view = editorViewRef.current;
    if (!view || !paths.length) return;
    const prepared: string[] = [];
    for (const path of paths) {
      const latexPath = await onPrepareFigure(path);
      if (latexPath) prepared.push(latexPath);
    }
    if (!prepared.length || !editorViewRef.current) return;
    const currentView = editorViewRef.current;
    let coordinatePosition: number | null = null;
    if (coordinates) {
      try {
        coordinatePosition = currentView.posAtCoords(coordinates);
      } catch {
        // CodeMirror may not have layout coordinates yet; use the current cursor instead.
      }
    }
    const cursor = coordinatePosition ?? lastInsertionPositionRef.current;
    const position = currentView.state.doc.lineAt(clamp(cursor, 0, currentView.state.doc.length)).from;
    const source = currentView.state.doc.toString();
    const edit = latexFigureInsertion(source, position, prepared);
    pendingFigureCursorRef.current = position + edit.cursorOffset;
    setSource(`${source.slice(0, position)}${edit.text}${source.slice(position)}`);
  }, [onPrepareFigure, setSource]);
  useEffect(() => {
    const view = editorViewRef.current;
    const cursor = pendingFigureCursorRef.current;
    if (!view || cursor === null || view.state.doc.toString() !== editorSource) return;
    pendingFigureCursorRef.current = null;
    view.dispatch({ selection: { anchor: cursor }, scrollIntoView: true });
    view.focus();
  }, [editorSource]);
  useEffect(() => {
    const request = editorNavigation;
    const view = editorViewRef.current;
    if (!request || !view || request.path !== activeFile) return;
    const frame = window.requestAnimationFrame(() => {
      const currentView = editorViewRef.current;
      if (!currentView) return;
      const lineNumber = clamp(request.line, 1, currentView.state.doc.lines);
      const line = currentView.state.doc.line(lineNumber);
      currentView.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      currentView.focus();
      onEditorNavigationHandled(request.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFile, editorNavigation, onEditorNavigationHandled, editorSource]);
  useEffect(() => {
    const view = editorViewRef.current;
    const point = props.figurePointerPosition;
    if (!view || !point) {
      setFigureDropMarker(null);
      return;
    }
    let position: number | null = null;
    try {
      position = view.posAtCoords(point);
    } catch {
      // Fall back to the last cursor when layout coordinates are unavailable.
    }
    const line = view.state.doc.lineAt(clamp(position ?? lastInsertionPositionRef.current, 0, view.state.doc.length));
    const editorBounds = view.dom.closest(".source-editor")?.getBoundingClientRect();
    const lineCoordinates = view.coordsAtPos(line.from);
    const top = editorBounds
      ? clamp((lineCoordinates?.top ?? point.y) - editorBounds.top, 0, editorBounds.height)
      : 0;
    setFigureDropMarker({ top, line: line.number });
  }, [props.figurePointerPosition]);
  useEffect(() => {
    if (!figureDropRequest) return;
    const request = figureDropRequest;
    void insertFigures(request.paths, { x: request.clientX, y: request.clientY })
      .finally(() => onFigureDropHandled(request.id));
  }, [figureDropRequest, insertFigures, onFigureDropHandled]);
  if (props.mode === "paper") {
    return (
      <article className="paper-reader">
        <div className="paper-reader-title"><BookOpen size={15} /><span>{props.activePaper?.title ?? "Imported paper"}</span>{props.activePaper && <small>arXiv {props.activePaper.arxivId}</small>}</div>
        <div className="paper-content" dangerouslySetInnerHTML={{ __html: paperHtml }} />
      </article>
    );
  }
  if (props.mode === "asset" && props.activeAsset) {
    return <ProjectAssetPreview asset={props.activeAsset} />;
  }
  const editor = (
    <div
      className={`source-editor ${figureDropActive || props.nativeFigureDropActive ? "figure-drop-active" : ""}`}
      onPointerLeave={props.onEditorLeave}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) props.onEditorLeave();
      }}
      onDragEnterCapture={(event) => {
        if (Array.from(event.dataTransfer.types).includes(PROJECT_FIGURE_DRAG_TYPE)) setFigureDropActive(true);
      }}
      onDragOverCapture={(event) => {
        if (!Array.from(event.dataTransfer.types).includes(PROJECT_FIGURE_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setFigureDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFigureDropActive(false);
      }}
      onDropCapture={(event) => {
        const path = event.dataTransfer.getData(PROJECT_FIGURE_DRAG_TYPE);
        if (!path) return;
        event.preventDefault();
        event.stopPropagation();
        setFigureDropActive(false);
        void insertFigures([path], { x: event.clientX, y: event.clientY });
      }}
    >
      <CodeMirror
        className="code-editor-root"
        value={props.source}
        height="100%"
        extensions={editorExtensions}
        onCreateEditor={(view) => {
          editorViewRef.current = view;
          lastInsertionPositionRef.current = view.state.selection.main.head;
        }}
        onChange={props.setSource}
        onUpdate={(view) => {
          const range = view.state.selection.main;
          lastInsertionPositionRef.current = range.head;
          props.setSelection(range.empty ? "" : view.state.sliceDoc(range.from, range.to));
        }}
        basicSetup={{
          autocompletion: false,
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: false,
        }}
      />
      {figureDropMarker && (
        <div className="figure-drop-line" style={{ top: figureDropMarker.top }}>
          <span>Insert above line {figureDropMarker.line}</span>
        </div>
      )}
    </div>
  );
  const preview = (
    <PdfPreview key={props.pdfUrl ?? "empty-pdf"} url={props.pdfUrl} pdfBase64={props.pdfBase64} onSource={props.onPdfSource} />
  );
  if (props.mode === "source") return editor;
  if (props.mode === "pdf") return preview;
  const resizeSplit = (clientX: number) => {
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds?.width) return splitRatio;
    const next = clamp((clientX - bounds.left) / bounds.width, 0.2, 0.8);
    setSplitRatio(next);
    return next;
  };
  const beginSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    let latest = splitRatio;
    document.body.classList.add("resizing-split");
    const handleMove = (moveEvent: PointerEvent) => {
      latest = resizeSplit(moveEvent.clientX);
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-split");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      persistSplitRatio(latest);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };
  const nudgeSplit = (delta: number) => {
    const next = clamp(splitRatio + delta, 0.2, 0.8);
    setSplitRatio(next);
    persistSplitRatio(next);
  };
  return (
    <div
      ref={splitRef}
      className="split-canvas"
      style={{ gridTemplateColumns: `minmax(220px, ${splitRatio}fr) 1px minmax(260px, ${1 - splitRatio}fr)` }}
    >
      {editor}
      <div
        className="split-resizer"
        role="separator"
        aria-label="Resize source and PDF preview"
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(splitRatio * 100)}
        tabIndex={0}
        onPointerDown={beginSplitResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            nudgeSplit(-0.03);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            nudgeSplit(0.03);
          }
        }}
      />
      {preview}
    </div>
  );
}

function ProjectAssetPreview({ asset }: { asset: AssetPreview }) {
  const url = `data:${asset.mimeType};base64,${asset.base64}`;
  if (asset.mimeType === "application/pdf") {
    return <PdfPreview url={url} pdfBase64={asset.base64} fileName={asset.path.split("/").pop() ?? "figure.pdf"} />;
  }
  return (
    <div className="asset-preview">
      <div className="asset-preview-heading">
        <Image size={14} />
        <span>{asset.path}</span>
        <small>Drag this file from Project into the LaTeX editor to insert it.</small>
      </div>
      <div className="asset-preview-stage">
        {asset.mimeType.startsWith("image/")
          ? <img src={url} alt={`Preview of ${asset.path}`} />
          : <div className="asset-preview-unsupported"><FileText size={28} /><p>This format cannot be rendered in the preview.</p></div>}
      </div>
    </div>
  );
}

function PdfPreview({ url, pdfBase64, fileName = "paper.pdf", onSource }: { url: string | null; pdfBase64: string | null; fileName?: string; onSource?: (page: number, x: number, y: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [loading, setLoading] = useState(Boolean(url));
  const [pdfError, setPdfError] = useState("");
  const [savingPdf, setSavingPdf] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");

  useEffect(() => {
    if (!url) return;
    let active = true;
    const loadingTask = getDocument({ url });
    void loadingTask.promise
      .then((pdf) => {
        if (active) setDocumentProxy(pdf);
      })
      .catch((reason) => active && setPdfError(toMessage(reason)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      void loadingTask.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!documentProxy || !canvasRef.current) return;
    let active = true;
    let cancelRender: (() => void) | undefined;
    void documentProxy.getPage(pageNumber)
      .then((page) => {
        if (!active || !canvasRef.current) return;
        const pixelRatio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * pixelRatio });
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
        canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;
        const renderTask = page.render({ canvas, viewport });
        cancelRender = () => renderTask.cancel();
        return renderTask.promise;
      })
      .catch((reason) => {
        if (active && reason?.name !== "RenderingCancelledException") setPdfError(toMessage(reason));
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      cancelRender?.();
    };
  }, [documentProxy, pageNumber, scale]);

  if (!url) {
    return <div className="pdf-preview"><div className="pdf-placeholder"><FileText size={28} /><p>Build the project to preview the paper.</p></div></div>;
  }

  const download = async () => {
    if (!pdfBase64 || savingPdf) return;
    setSavingPdf(true);
    setSaveNotice("");
    try {
      const destination = await saveDialog({
        title: "Save compiled PDF",
        defaultPath: fileName,
        filters: [{ name: "PDF document", extensions: ["pdf"] }],
      });
      if (!destination) return;
      const savedPath = await invoke<string>("save_compiled_pdf", { path: destination, pdfBase64 });
      setSaveNotice(`Saved to ${savedPath}`);
    } catch (reason) {
      setSaveNotice(`Could not save PDF. ${toMessage(reason)}`);
    } finally {
      setSavingPdf(false);
    }
  };
  const revealSource = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSource) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    onSource(
      pageNumber,
      Number(((event.clientX - bounds.left) / scale).toFixed(3)),
      Number(((event.clientY - bounds.top) / scale).toFixed(3)),
    );
  };
  return (
    <div className="pdf-preview">
      <div className="pdf-toolbar">
        <div className="pdf-page-controls">
          <button title="Previous page" disabled={pageNumber <= 1} onClick={() => { setLoading(true); setPageNumber((page) => Math.max(1, page - 1)); }}><ChevronLeft size={14} /></button>
          <span>{pageNumber} / {documentProxy?.numPages ?? "–"}</span>
          <button title="Next page" disabled={!documentProxy || pageNumber >= documentProxy.numPages} onClick={() => { setLoading(true); setPageNumber((page) => Math.min(documentProxy?.numPages ?? page, page + 1)); }}><ChevronRight size={14} /></button>
        </div>
        <div className="pdf-zoom-controls">
          <button title="Zoom out" disabled={scale <= 0.6} onClick={() => { setLoading(true); setScale((value) => clamp(Number((value - 0.1).toFixed(1)), 0.6, 2.2)); }}><ZoomOut size={14} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button title="Zoom in" disabled={scale >= 2.2} onClick={() => { setLoading(true); setScale((value) => clamp(Number((value + 0.1).toFixed(1)), 0.6, 2.2)); }}><ZoomIn size={14} /></button>
        </div>
        <button className="pdf-download" title="Save PDF as…" disabled={!pdfBase64 || savingPdf} onClick={() => void download()}>{savingPdf ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}</button>
      </div>
      {saveNotice && <div className={`pdf-save-notice ${saveNotice.startsWith("Could not") ? "error" : ""}`}>{saveNotice}<button title="Dismiss PDF save notice" onClick={() => setSaveNotice("")}><X size={12} /></button></div>}
      <div className="pdf-scroll-area">
        {pdfError ? <div className="pdf-placeholder"><CircleAlert size={24} /><p>{pdfError}</p></div> : <canvas ref={canvasRef} className={onSource ? "synctex-enabled" : ""} title={onSource ? "Click to reveal this position in LaTeX" : undefined} onClick={revealSource} aria-label={`PDF page ${pageNumber}`} />}
        {loading && <div className="pdf-loading"><LoaderCircle className="spin" size={17} /> Rendering PDF…</div>}
      </div>
    </div>
  );
}

function HistoryDrawer(props: {
  history: HistoryItem[];
  onClose: () => void;
  onRevert: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="history-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header"><div><History size={16} /><span>Project history</span></div><button onClick={props.onClose}><X size={16} /></button></div>
        <p className="drawer-copy">Every direct edit, paper import, and agent change is stored as a project transaction.</p>
        <div className="history-list">
          {props.history.map((item) => (
            <div className="history-item" key={item.id}>
              <div className="history-dot" />
              <div className="history-body">
                <strong>{item.label}</strong>
                <span><Clock3 size={11} /> {new Date(item.timestamp).toLocaleString()}</span>
                <p>{item.files.join(", ")}</p>
              </div>
              <div className="history-actions">
                <button title="Restore the state before this change" onClick={() => props.onRevert(item.id)}><RotateCcw size={14} /></button>
                <button className="history-delete" title="Delete this history entry" onClick={() => props.onDelete(item.id)}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          {!props.history.length && <p className="empty-history">No changes recorded yet.</p>}
        </div>
      </aside>
    </div>
  );
}

function SettingsDialog(props: {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  appearance: AppearanceSettings;
  setAppearance: (appearance: AppearanceSettings) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  buildPreferences: BuildPreferences;
  setBuildPreferences: (preferences: BuildPreferences) => void;
  systemPrompt: string;
  setSystemPrompt: (prompt: string) => void;
  hasProject: boolean;
  skills: AgentSkill[];
  skillDraft: SkillDraft | null;
  setSkillDraft: (draft: SkillDraft | null) => void;
  onSaveSkill: (draft: SkillDraft) => void;
  onSetSkillEnabled: (name: string, enabled: boolean) => void;
  onDeleteSkill: (skill: AgentSkill) => void;
  subscriptions: SubscriptionStatus[];
  subscriptionsLoading: boolean;
  subscriptionNotice: string;
  onRefreshSubscriptions: () => void;
  onSubscriptionLogin: (provider: "codex" | "claude") => void;
  apiProvider: "openai" | "anthropic";
  setApiProvider: (provider: "openai" | "anthropic") => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  apiConfigured: boolean;
  onSaveApiKey: () => void;
  onDeleteApiKey: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div><Settings2 size={17} /><span>Settings</span></div>
          <button title="Close settings" onClick={props.onClose}><X size={16} /></button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            <button className={props.tab === "appearance" ? "active" : ""} onClick={() => props.setTab("appearance")}>Appearance</button>
            <button className={props.tab === "editor" ? "active" : ""} onClick={() => props.setTab("editor")}>Editor & builds</button>
            <button className={props.tab === "agent" ? "active" : ""} onClick={() => props.setTab("agent")}>Agent</button>
            <button className={props.tab === "accounts" ? "active" : ""} onClick={() => props.setTab("accounts")}>Subscriptions</button>
            <button className={props.tab === "api" ? "active" : ""} onClick={() => props.setTab("api")}>API keys</button>
          </nav>
          <div className="settings-content">
            {props.tab === "appearance" && (
              <div className="settings-section">
                <h2>Appearance</h2>
                <p>These preferences apply across every project on this Mac.</p>
                <label>Color theme
                  <select aria-label="Color theme" value={props.theme} onChange={(event) => props.setTheme(event.target.value as Theme)}>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <label>Interface font
                  <select value={props.appearance.uiFont} onChange={(event) => props.setAppearance({ ...props.appearance, uiFont: event.target.value })}>
                    <option value='"DM Sans", -apple-system, sans-serif'>DM Sans</option>
                    <option value='Inter, -apple-system, sans-serif'>Inter</option>
                    <option value='-apple-system, BlinkMacSystemFont, sans-serif'>System</option>
                    <option value='"Avenir Next", sans-serif'>Avenir Next</option>
                  </select>
                </label>
                <div className="settings-range">
                  <div><label htmlFor="interface-size">Interface size</label><output>{Math.round(props.appearance.interfaceScale * 100)}%</output></div>
                  <input id="interface-size" type="range" min="90" max="135" step="5" value={Math.round(props.appearance.interfaceScale * 100)} onChange={(event) => props.setAppearance({ ...props.appearance, interfaceScale: Number(event.target.value) / 100 })} />
                </div>
                <label>LaTeX editor font
                  <select value={props.appearance.editorFont} onChange={(event) => props.setAppearance({ ...props.appearance, editorFont: event.target.value })}>
                    <option value='"MonoLisa", "JetBrains Mono", monospace'>MonoLisa</option>
                    <option value='"JetBrains Mono", monospace'>JetBrains Mono</option>
                    <option value='"SFMono-Regular", Consolas, monospace'>SF Mono</option>
                    <option value='"Fira Code", monospace'>Fira Code</option>
                    <option value='Menlo, monospace'>Menlo</option>
                  </select>
                </label>
                <div className="settings-range">
                  <div><label htmlFor="editor-font-size">Editor font size</label><output>{props.appearance.editorFontSize}px</output></div>
                  <input id="editor-font-size" type="range" min="10" max="24" step="1" value={props.appearance.editorFontSize} onChange={(event) => props.setAppearance({ ...props.appearance, editorFontSize: Number(event.target.value) })} />
                </div>
              </div>
            )}
            {props.tab === "editor" && (
              <div className="settings-section">
                <h2>Editor & builds</h2>
                <p>Choose when Lattice recompiles the current project after a source change.</p>
                <label>Automatic build
                  <select aria-label="Automatic build" value={props.buildPreferences.autoBuildMode} onChange={(event) => props.setBuildPreferences({ autoBuildMode: event.target.value as AutoBuildMode })}>
                    <option value="manual">Manual only</option>
                    <option value="automatic">Automatic</option>
                  </select>
                </label>
                <div className="settings-detail">
                  <Play size={14} />
                  <div><strong>{autoBuildTitle(props.buildPreferences.autoBuildMode)}</strong><span>{autoBuildDetail(props.buildPreferences.autoBuildMode)}</span></div>
                </div>
              </div>
            )}
            {props.tab === "agent" && (
              <div className="settings-section">
                <h2>Agent</h2>
                <p>Lattice runs Pi directly. The prompt and skills below stay inside Lattice and never change your global agent setup.</p>
                <label htmlFor="agent-system-prompt">System prompt
                  <textarea
                    id="agent-system-prompt"
                    aria-label="Agent system prompt"
                    placeholder="Write the system prompt you want Pi to use…"
                    value={props.systemPrompt}
                    onChange={(event) => props.setSystemPrompt(event.target.value)}
                  />
                </label>
                <div className="skill-heading">
                  <div><strong>Skills</strong><span>Enabled skills are given to Pi on its next turn.</span></div>
                  <button onClick={() => props.setSkillDraft({ scope: "application", content: "---\nname: new-skill\ndescription: Describe when Pi should use this skill.\n---\n\n# New skill\n\nWrite the instructions here.\n" })}><Plus size={12} /> Add skill</button>
                </div>
                {props.skillDraft ? (
                  <div className="skill-editor">
                    <label>Availability
                      <select value={props.skillDraft.scope} onChange={(event) => props.setSkillDraft({ ...props.skillDraft!, scope: event.target.value as "application" | "project" })}>
                        <option value="application">All Lattice projects</option>
                        <option value="project" disabled={!props.hasProject}>This project only</option>
                      </select>
                    </label>
                    <label>SKILL.md
                      <textarea aria-label="Skill instructions" value={props.skillDraft.content} onChange={(event) => props.setSkillDraft({ ...props.skillDraft!, content: event.target.value })} />
                    </label>
                    <div className="skill-editor-actions"><button onClick={() => props.setSkillDraft(null)}>Cancel</button><button className="primary-button" onClick={() => props.onSaveSkill(props.skillDraft!)}>Save skill</button></div>
                  </div>
                ) : (
                  <div className="skill-list">
                    {props.skills.map((skill) => (
                      <div className="skill-card" key={skill.name}>
                        <button className={`skill-toggle ${skill.enabled ? "enabled" : ""}`} role="switch" aria-checked={skill.enabled} aria-label={`Enable ${skill.name}`} onClick={() => props.onSetSkillEnabled(skill.name, !skill.enabled)}><span /></button>
                        <div><strong>{skill.name}</strong><small>{skill.scope === "built-in" ? "Bundled" : skill.scope === "application" ? "All projects" : "This project"}{skill.overridden ? " · overrides bundled" : ""}</small><p>{skill.description}</p></div>
                        <div className="skill-actions">
                          <button title={`Edit ${skill.name}`} onClick={() => props.setSkillDraft({ originalName: skill.name, scope: skill.scope === "project" ? "project" : "application", content: skill.content })}><Pencil size={12} /></button>
                          {skill.scope !== "built-in" && <button title={skill.overridden ? `Restore bundled ${skill.name}` : `Delete ${skill.name}`} onClick={() => props.onDeleteSkill(skill)}>{skill.overridden ? <RotateCcw size={12} /> : <Trash2 size={12} />}</button>}
                        </div>
                      </div>
                    ))}
                    {!props.skills.length && <p className="settings-empty">No skills are installed in Lattice.</p>}
                  </div>
                )}
              </div>
            )}
            {props.tab === "accounts" && (
              <div className="settings-section">
                <div className="settings-section-title"><div><h2>Subscriptions</h2><p>Lattice uses the login already owned by each local CLI.</p></div><button title="Refresh subscription status" onClick={props.onRefreshSubscriptions} disabled={props.subscriptionsLoading}><RefreshCw className={props.subscriptionsLoading ? "spin" : ""} size={14} /></button></div>
                <div className="account-list">
                  {props.subscriptions.map((account) => (
                    <div className="account-card" key={account.provider}>
                      <div className={`account-mark ${account.loggedIn ? "connected" : ""}`}>{account.provider === "codex" ? "O" : "C"}</div>
                      <div><strong>{account.provider === "codex" ? "Codex subscription" : "Claude subscription"}</strong><small>{account.detail}</small></div>
                      {!account.loggedIn && <button disabled={!account.installed} onClick={() => props.onSubscriptionLogin(account.provider)}>Sign in</button>}
                      {account.loggedIn && <span className="connected-label"><Check size={12} /> Connected</span>}
                    </div>
                  ))}
                  {!props.subscriptions.length && <p className="settings-empty">{props.subscriptionsLoading ? "Checking local subscriptions…" : "Refresh to check local subscriptions."}</p>}
                </div>
                {props.subscriptionNotice && <p className="settings-notice">{props.subscriptionNotice}</p>}
              </div>
            )}
            {props.tab === "api" && (
              <div className="settings-section">
                <h2>API keys</h2>
                <p>API keys are optional and only used by the API providers. Subscription providers use their own CLI login.</p>
                <label>Provider
                  <select value={props.apiProvider} onChange={(event) => props.setApiProvider(event.target.value as "openai" | "anthropic")}>
                    <option value="openai">OpenAI API</option>
                    <option value="anthropic">Anthropic API</option>
                  </select>
                </label>
                <label>
                  <span className="key-label">API key {props.apiConfigured && <span className="configured-label"><Check size={11} /> Configured</span>}</span>
                  <input type="password" autoComplete="off" placeholder={props.apiConfigured ? "Enter a replacement key" : "Paste API key"} value={props.apiKey} onChange={(event) => props.setApiKey(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.apiKey.trim() && props.onSaveApiKey()} />
                </label>
                <div className="settings-api-actions">
                  {props.apiConfigured && <button className="delete-key-button" onClick={props.onDeleteApiKey}><Trash2 size={13} /> Remove</button>}
                  <span />
                  <button className="primary-button" onClick={props.onSaveApiKey} disabled={!props.apiKey.trim()}>Save key</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function base64PdfUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}

function beginWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.buttons !== 1 || (event.target as Element).closest("button, input, select, textarea, a")) return;
  event.preventDefault();
  void getCurrentWindow().startDragging();
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function modelOptions(provider: AgentProvider): ModelOption[] {
  const standard = ["low", "medium", "high", "xhigh"] as ReasoningEffort[];
  const frontier = [...standard, "max"] as ReasoningEffort[];
  switch (provider) {
    case "codex":
      return [
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: [...frontier, "ultra"] },
        { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: [...frontier, "ultra"] },
        { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: frontier },
        { value: "gpt-5.5", label: "GPT-5.5", efforts: standard },
        { value: "gpt-5.4", label: "GPT-5.4", efforts: standard },
        { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", efforts: standard },
      ];
    case "openai-api":
      return [
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["none", ...frontier] },
        { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: ["none", ...frontier] },
        { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: ["none", ...frontier] },
        { value: "gpt-5.5", label: "GPT-5.5", efforts: standard },
        { value: "gpt-5.4", label: "GPT-5.4", efforts: standard },
        { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", efforts: standard },
      ];
    case "claude":
      return [
        { value: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: frontier },
        { value: "claude-opus-4-7", label: "Claude Opus 4.7", efforts: frontier },
        { value: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: frontier },
        { value: "claude-opus-4-5", label: "Claude Opus 4.5", efforts: frontier },
        { value: "claude-opus-4-1", label: "Claude Opus 4.1", efforts: frontier },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: frontier },
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: frontier },
        { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: frontier },
      ];
    case "anthropic-api":
      return [
        { value: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: frontier },
        { value: "claude-opus-4-7", label: "Claude Opus 4.7", efforts: frontier },
        { value: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: frontier },
        { value: "claude-opus-4-5", label: "Claude Opus 4.5", efforts: frontier },
        { value: "claude-opus-4-1", label: "Claude Opus 4.1", efforts: frontier },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: frontier },
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: frontier },
        { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: frontier },
      ];
  }
}

function defaultModel(provider: AgentProvider): string {
  return modelOptions(provider)[0].value;
}

function normalizeModel(provider: AgentProvider, model: string | undefined): string {
  if (provider === "claude") {
    if (model === "sonnet") return "claude-sonnet-5";
    if (model === "opus") return "claude-opus-4-8";
    if (model === "fable" || model === "claude-fable-5") return "claude-sonnet-5";
  }
  return modelOptions(provider).some((option) => option.value === model) ? model as string : defaultModel(provider);
}

function modelLabel(provider: AgentProvider, model: string): string {
  return modelOptions(provider).find((option) => option.value === model)?.label ?? model;
}

function normalizeEffort(value: string | undefined): ReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"
    ? value
    : "high";
}

function compactConversationTitle(title: string): string {
  return title === "New conversation" ? "New" : title;
}

function autoBuildTitle(mode: AutoBuildMode): string {
  if (mode === "automatic") return "Build automatically";
  return "Build only when requested";
}

function autoBuildDetail(mode: AutoBuildMode): string {
  if (mode === "automatic") return "Lattice saves and builds when you leave the editor or after 1.2 seconds without typing.";
  return "Use the Build button or Command-S. Source changes are still saved automatically.";
}

function autoBuildDescription(mode: AutoBuildMode): string {
  return `${autoBuildTitle(mode)} · Command-S builds now`;
}

function relativeTime(timestamp: string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function loadRecentProjects(): RecentProject[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is RecentProject => Boolean(
        item && typeof item === "object" && "name" in item && typeof item.name === "string" &&
        "path" in item && typeof item.path === "string",
      ))
      .slice(0, 8);
  } catch {
    return [];
  }
}

function persistRecentProjects(projects: RecentProject[]) {
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    // Recent projects are a convenience; project access still works if storage is unavailable.
  }
}

function loadPanelWidths(): PanelWidths {
  try {
    const value = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? "null") as Partial<PanelWidths> | null;
    return {
      navigator: clamp(Number(value?.navigator) || 220, 160, 420),
      agent: clamp(Number(value?.agent) || 340, 260, 600),
    };
  } catch {
    return { navigator: 220, agent: 340 };
  }
}

function loadAppearance(): AppearanceSettings {
  const defaults: AppearanceSettings = {
    uiFont: '"DM Sans", -apple-system, sans-serif',
    interfaceScale: 1.1,
    editorFont: '"MonoLisa", "JetBrains Mono", monospace',
    editorFontSize: 14,
  };
  try {
    const current = localStorage.getItem(APPEARANCE_KEY);
    const legacy = localStorage.getItem(LEGACY_APPEARANCE_KEY);
    const value = JSON.parse(current ?? legacy ?? "null") as Partial<AppearanceSettings> | null;
    const migratedEditorFont = !current && value?.editorFont === '"JetBrains Mono", monospace'
      ? defaults.editorFont
      : value?.editorFont;
    return {
      uiFont: typeof value?.uiFont === "string" ? value.uiFont : defaults.uiFont,
      interfaceScale: clamp(Number(value?.interfaceScale) || defaults.interfaceScale, 0.9, 1.35),
      editorFont: typeof migratedEditorFont === "string" ? migratedEditorFont : defaults.editorFont,
      editorFontSize: clamp(Number(value?.editorFontSize) || defaults.editorFontSize, 10, 24),
    };
  } catch {
    return defaults;
  }
}

function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to the system preference when storage is unavailable.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function loadBuildPreferences(): BuildPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(BUILD_PREFERENCES_KEY) ?? "null") as { autoBuildMode?: string } | null;
    const autoBuildMode = value?.autoBuildMode;
    return {
      autoBuildMode: autoBuildMode === "manual" ? "manual" : "automatic",
    };
  } catch {
    return { autoBuildMode: "automatic" };
  }
}

function loadSystemPrompt(): string {
  try {
    return localStorage.getItem(AGENT_SYSTEM_PROMPT_KEY) ?? "";
  } catch {
    return "";
  }
}

function projectItemPath(root: string, relativePath: string): string {
  if (!relativePath) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

function loadSplitRatio(): number {
  try {
    return clamp(Number(localStorage.getItem(SPLIT_RATIO_KEY)) || 0.46, 0.2, 0.8);
  } catch {
    return 0.46;
  }
}

function persistSplitRatio(ratio: number) {
  try {
    localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
  } catch {
    // Split resizing remains available for the current session without storage.
  }
}

function loadNavigatorSplit(): number {
  try {
    return clamp(Number(localStorage.getItem(NAVIGATOR_SPLIT_KEY)) || 0.58, 0.2, 0.78);
  } catch {
    return 0.58;
  }
}

function persistNavigatorSplit(ratio: number) {
  try {
    localStorage.setItem(NAVIGATOR_SPLIT_KEY, String(ratio));
  } catch {
    // Navigator resizing remains available for the current session without storage.
  }
}

function dropDirectoryAt(position: { x: number; y: number }): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(position.x / scale, position.y / scale);
  const directory = element?.closest<HTMLElement>("[data-drop-directory]")?.dataset.dropDirectory;
  if (directory) return directory;
  return element?.closest(".navigator") ? "figures" : null;
}

function dropEditorAt(position: { x: number; y: number }): { x: number; y: number } | null {
  const scale = window.devicePixelRatio || 1;
  const point = { x: position.x / scale, y: position.y / scale };
  return document.elementFromPoint(point.x, point.y)?.closest(".source-editor") ? point : null;
}

function persistPanelWidths(widths: PanelWidths) {
  try {
    localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Panel resizing remains available for the current session without storage.
  }
}

function resizePanelWidths(
  panel: PanelKind,
  start: PanelWidths,
  delta: number,
  navigatorOpen: boolean,
): PanelWidths {
  const canvasMinimum = 360;
  const handles = navigatorOpen ? 10 : 5;
  if (panel === "navigator") {
    const maximum = Math.max(160, Math.min(420, window.innerWidth - start.agent - canvasMinimum - handles));
    return { ...start, navigator: clamp(start.navigator + delta, 160, maximum) };
  }
  const navigatorWidth = navigatorOpen ? start.navigator : 0;
  const maximum = Math.max(260, Math.min(600, window.innerWidth - navigatorWidth - canvasMinimum - handles));
  return { ...start, agent: clamp(start.agent + delta, 260, maximum) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export default App;
