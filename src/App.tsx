import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
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
  History,
  ImagePlus,
  KeyRound,
  Library,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RotateCcw,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Sun,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { marked } from "marked";
import { latexEditorExtensions } from "./latex-editor";
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
};

type PaperSummary = {
  arxivId: string;
  title: string;
  citationKey?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  files?: string[];
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

type CanvasMode = "source" | "pdf" | "split" | "paper";
type Theme = "light" | "dark";
type AgentProvider = "codex" | "claude" | "openai-api" | "anthropic-api";
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type RecentProject = { name: string; path: string };
type PanelKind = "navigator" | "agent";
type PanelWidths = { navigator: number; agent: number };
type SettingsTab = "appearance" | "accounts" | "api";
type AppearanceSettings = { uiFont: string; editorFont: string; editorFontSize: number };
type SubscriptionStatus = { provider: "codex" | "claude"; installed: boolean; loggedIn: boolean; detail: string };
type ModelOption = { value: string; label: string; efforts: ReasoningEffort[] };

const RECENT_PROJECTS_KEY = "lattice.recent-projects.v1";
const PANEL_WIDTHS_KEY = "lattice.panel-widths.v1";
const APPEARANCE_KEY = "lattice.appearance.v2";
const SPLIT_RATIO_KEY = "lattice.split-ratio.v1";
const NAVIGATOR_SPLIT_KEY = "lattice.navigator-split.v1";

const defaultWelcomeMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "agent",
    text: "Tell me what you want to write or revise. I can work across the project, use imported papers as evidence, and leave every change undoable.",
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
  const [messages, setMessages] = useState<ChatMessage[]>(defaultWelcomeMessages);
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [agentInput, setAgentInput] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [agentModel, setAgentModel] = useState(defaultModel("codex"));
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [agentRunning, setAgentRunning] = useState(false);
  const [importInput, setImportInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [assetImporting, setAssetImporting] = useState(false);
  const [assetDropTarget, setAssetDropTarget] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(true);
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(loadPanelWidths);
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(loadRecentProjects);
  const [projectName, setProjectName] = useState("Untitled research");
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance);
  const [subscriptions, setSubscriptions] = useState<SubscriptionStatus[]>([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [subscriptionNotice, setSubscriptionNotice] = useState("");
  const [apiProvider, setApiProvider] = useState<"openai" | "anthropic">("openai");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, boolean>>({});
  const saveTimer = useRef<number | null>(null);
  const chatEnd = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

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
      setCanvasMode((mode) => (mode === "paper" ? "split" : mode));
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

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

  const compile = useCallback(async () => {
    if (!project || building) return;
    setBuilding(true);
    try {
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
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBuilding(false);
    }
  }, [building, project]);

  const enterProject = useCallback(
    async (snapshot: ProjectSnapshot) => {
      setProject(snapshot);
      rememberProject(snapshot);
      setProjectMenuOpen(false);
      setBuild(null);
      setSelection("");
      setActivePaper(null);
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
    [loadFile, rememberProject],
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
    const parent = await open({ directory: true, multiple: false, title: "Choose where to create the project" });
    if (!parent) return;
    setBusyLabel("Creating project…");
    try {
      if (!(await save())) return;
      const snapshot = await invoke<ProjectSnapshot>("create_project", { parent, name: projectName });
      setCreateOpen(false);
      await enterProject(snapshot);
    } catch (reason) {
      setError(toMessage(reason));
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
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, agentRunning]);

  useEffect(() => {
    if (!project || !activeFile || source === savedSource) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), 900);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [activeFile, project, save, savedSource, source]);

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
      const result = await invoke<{ arxivId: string; title: string; citationKey?: string }>("import_arxiv", {
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
          text: `Imported “${result.title}”${result.citationKey ? ` as \\cite{${result.citationKey}}` : ""}.`,
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
      setCanvasMode("paper");
    } catch (reason) {
      setError(toMessage(reason));
    }
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

  const importProjectAssets = useCallback(async (paths: string[], targetDirectory = "figures") => {
    if (!paths.length || assetImporting) return;
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
    } catch (reason) {
      setError(toMessage(reason));
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
          return;
        }
        const targetDirectory = dropDirectoryAt(event.payload.position);
        setAssetDropTarget(targetDirectory);
        if (event.payload.type === "drop") {
          setAssetDropTarget(null);
          if (targetDirectory) void importProjectAssets(event.payload.paths, targetDirectory);
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
      }
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeFile, loadFile, refreshHistory, refreshProject]);

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
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", text: message };
    const pendingMessages = [...messages, userMessage];
    setAgentInput("");
    setMessages(pendingMessages);
    setAgentRunning(true);
    let session = activeSession;
    let currentMessages = pendingMessages;
    try {
      if (!session) session = await invoke<AgentSession>("create_agent_session", {
        provider,
        model: agentModel,
        reasoningEffort,
      });
      session = await invoke<AgentSession>("save_agent_session", {
        session: { ...session, provider, model: agentModel, reasoningEffort, messages: pendingMessages },
      });
      setActiveSession(session);
      await refreshAgentSessions();
      if (!(await save())) throw new Error("Save the current file before running the agent.");
      const result = await invoke<AgentResult>("run_agent", {
        settings: { provider, model: agentModel, reasoningEffort },
        message,
        activeFile: activeFile || null,
        selection: selection || null,
        conversation: messages,
      });
      const completedMessages: ChatMessage[] = [...pendingMessages, {
        id: crypto.randomUUID(),
        role: "agent",
        text: result.summary,
        files: result.changedFiles,
      }];
      currentMessages = completedMessages;
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
    }
  }, [activeFile, activeSession, agentInput, agentModel, agentRunning, compile, loadFile, messages, provider, reasoningEffort, refreshAgentSessions, refreshHistory, refreshProject, save, selection]);

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

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setSubscriptionNotice("");
    if (tab === "api") void refreshApiKeys().catch((reason) => setError(toMessage(reason)));
    if (tab === "accounts") void refreshSubscriptions();
  }, [refreshApiKeys, refreshSubscriptions]);

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
      }}
      appearance={appearance}
      setAppearance={setAppearance}
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
          projectName={projectName}
          setCreateOpen={setCreateOpen}
          setProjectName={setProjectName}
          onCreate={createProject}
          onOpen={chooseExisting}
          onSettings={() => openSettings("appearance")}
          theme={theme}
          toggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        />
        {settingsDialog}
      </>
    );
  }

  return (
    <div className="app-shell" ref={shellRef}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="traffic-space" data-tauri-drag-region />
        <button className="icon-button" onClick={() => setNavigatorOpen((value) => !value)} title="Toggle navigator">
          {navigatorOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <div className="project-switcher">
          <button
            className="project-title"
            aria-label="Switch project"
            aria-expanded={projectMenuOpen}
            disabled={agentRunning || building || importing}
            onClick={() => setProjectMenuOpen((value) => !value)}
          >
            <span>{project.manifest.name}</span>
            <span className="project-path">{project.root}</span>
            <ChevronDown size={13} />
          </button>
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
          <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className={`build-button ${build?.success ? "success" : ""}`} onClick={compile} disabled={building}>
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
              activeFile={activeFile}
              protectedPaths={[
                ...project.manifest.rootDocuments.map((document) => document.path),
                project.manifest.primaryBibliography,
              ]}
              papers={papers}
              activePaper={activePaper}
              onFile={loadFile}
              onCreateEntry={createProjectEntry}
              onDeleteEntry={deleteProjectEntry}
              onImportAssets={chooseProjectAssets}
              assetDropTarget={assetDropTarget}
              assetImporting={assetImporting}
              onPaper={openPaper}
              onDeletePaper={deletePaper}
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
          input={agentInput}
          setInput={setAgentInput}
          provider={provider}
          setProvider={changeProvider}
          model={agentModel}
          setModel={setAgentModel}
          reasoningEffort={reasoningEffort}
          setReasoningEffort={setReasoningEffort}
          running={agentRunning}
          onSend={sendToAgent}
          onApiSettings={() => openSettings("api")}
          selection={selection}
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
            setMode={setCanvasMode}
            activeFile={activeFile}
            dirty={source !== savedSource}
            onHistory={() => setHistoryOpen(true)}
          />
          <DocumentCanvas
            mode={canvasMode}
            source={source}
            setSource={setSource}
            setSelection={setSelection}
            pdfUrl={pdfUrl}
            paperMarkdown={paperMarkdown}
            activePaper={activePaper}
            citationKeys={citationKeys}
          />
        </section>
      </main>

      {historyOpen && (
        <HistoryDrawer history={history} onClose={() => setHistoryOpen(false)} onRevert={revert} onDelete={deleteHistory} />
      )}
      {settingsDialog}
      {createOpen && (
        <CreateProjectDialog
          projectName={projectName}
          setProjectName={setProjectName}
          onCreate={createProject}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

function Welcome(props: {
  busyLabel: string | null;
  createOpen: boolean;
  error: string | null;
  projectName: string;
  setCreateOpen: (value: boolean) => void;
  setProjectName: (value: string) => void;
  onCreate: () => void;
  onOpen: () => void;
  onSettings: () => void;
  theme: Theme;
  toggleTheme: () => void;
}) {
  return (
    <div className="welcome-screen">
      <div className="welcome-titlebar" data-tauri-drag-region>
        <button className="icon-button" onClick={props.onSettings} title="Settings"><Settings2 size={16} /></button>
        <button className="icon-button" onClick={props.toggleTheme}>
          {props.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
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
          <button className="primary-button" onClick={() => props.setCreateOpen(true)}>
            <Plus size={17} /> New project
          </button>
          <button className="secondary-button" onClick={props.onOpen}>
            <FolderOpen size={17} /> Open folder
          </button>
        </div>
        {props.busyLabel && <p className="busy-label"><LoaderCircle className="spin" size={15} /> {props.busyLabel}</p>}
        {props.error && <p className="welcome-error">{props.error}</p>}
      </div>
      {props.createOpen && <CreateProjectDialog projectName={props.projectName} setProjectName={props.setProjectName} onCreate={props.onCreate} onClose={() => props.setCreateOpen(false)} />}
    </div>
  );
}

function CreateProjectDialog(props: {
  projectName: string;
  setProjectName: (value: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><FileText size={20} /></div>
        <h2>Create a research project</h2>
        <p>Lattice will create a polished two-column arXivTeX paper, bibliography, project brief, and private conversation history.</p>
        <label>
          Project name
          <input autoFocus value={props.projectName} onChange={(event) => props.setProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onCreate()} />
        </label>
        <div className="modal-actions">
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <button className="primary-button" onClick={props.onCreate}>Choose location</button>
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
  protectedPaths: string[];
  papers: PaperSummary[];
  activePaper: PaperSummary | null;
  onFile: (path: string) => void;
  onCreateEntry: (path: string, kind: "file" | "folder") => Promise<void>;
  onDeleteEntry: (path: string) => void;
  onImportAssets: (targetDirectory?: string) => void;
  assetDropTarget: string | null;
  assetImporting: boolean;
  onPaper: (paper: PaperSummary) => void;
  onDeletePaper: (paper: PaperSummary) => void;
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
        <div className="section-heading">
          <span>Project</span>
          <button className="section-action" title="Add file or folder" onClick={() => setEntryFormOpen((value) => !value)}><Plus size={13} /></button>
        </div>
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
            <button title="Cancel file creation" disabled={entryBusy} onClick={closeEntryForm}><X size={13} /></button>
          </div>
        )}
        <div className="file-tree">
          {props.files.map((node) => <TreeNode key={node.path} node={node} activeFile={props.activeFile} protectedPaths={props.protectedPaths} onFile={props.onFile} onDelete={props.onDeleteEntry} onImportAssets={props.onImportAssets} assetDropTarget={props.assetDropTarget} assetImporting={props.assetImporting} />)}
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
          <span className="count-badge">{props.papers.length}</span>
        </div>
        <div className="paper-list">
          {props.papers.map((paper) => (
            <div key={paper.arxivId} className={`paper-row ${props.activePaper?.arxivId === paper.arxivId ? "active" : ""}`}>
              <button title={paper.title} className="paper-open" onClick={() => props.onPaper(paper)}>
                <BookOpen size={14} />
                <span><strong>{paper.title}</strong><small>{paper.citationKey ? `\\cite{${paper.citationKey}}` : `arXiv ${paper.arxivId}`}</small></span>
              </button>
              <button className="row-delete" title={`Remove ${paper.title}`} onClick={() => props.onDeletePaper(paper)}><Trash2 size={12} /></button>
            </div>
          ))}
          {!props.papers.length && <p className="empty-note">Add an arXiv paper to ground the agent in project evidence.</p>}
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
    </aside>
  );
}

function TreeNode({ node, activeFile, protectedPaths, onFile, onDelete, onImportAssets, assetDropTarget, assetImporting }: { node: FileNode; activeFile: string; protectedPaths: string[]; onFile: (path: string) => void; onDelete: (path: string) => void; onImportAssets: (targetDirectory?: string) => void; assetDropTarget: string | null; assetImporting: boolean }) {
  const [open, setOpen] = useState(true);
  const protectedEntry = protectedPaths.some((path) => path === node.path || path.startsWith(`${node.path}/`));
  if (node.kind === "directory") {
    return (
      <div className={`tree-directory ${assetDropTarget === node.path ? "drop-target" : ""}`} data-drop-directory={node.path}>
        <div className="tree-row">
          <button className="tree-main" onClick={() => setOpen((value) => !value)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Folder size={14} /> <span>{node.name}</span>
          </button>
          {node.path === "figures" && <button className="row-import" title="Import images into figures" disabled={assetImporting} onClick={() => onImportAssets(node.path)}>{assetImporting ? <LoaderCircle className="spin" size={12} /> : <ImagePlus size={12} />}</button>}
          {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
        </div>
        {assetDropTarget === node.path && <div className="asset-drop-hint">Drop images into {node.path}</div>}
        {open && <div className="tree-children">{node.children.map((child) => <TreeNode key={child.path} node={child} activeFile={activeFile} protectedPaths={protectedPaths} onFile={onFile} onDelete={onDelete} onImportAssets={onImportAssets} assetDropTarget={assetDropTarget} assetImporting={assetImporting} />)}</div>}
      </div>
    );
  }
  const Icon = node.kind === "tex" ? FileCode2 : node.kind === "bib" ? Library : File;
  if (node.kind === "figure") {
    return (
      <div className="tree-row asset-row" title="Binary assets are listed here but are not opened in the source editor.">
        <div className="tree-main"><span className="tree-spacer" /><Icon size={14} /><span>{node.name}</span></div>
        {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
      </div>
    );
  }
  return (
    <div className={`tree-row ${activeFile === node.path ? "active" : ""}`}>
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
  input,
  setInput,
  provider,
  setProvider,
  model,
  setModel,
  reasoningEffort,
  setReasoningEffort,
  running,
  onSend,
  onApiSettings,
  selection,
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
  input: string;
  setInput: (value: string) => void;
  provider: AgentProvider;
  setProvider: (value: AgentProvider) => void;
  model: string;
  setModel: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  running: boolean;
  onSend: () => void;
  onApiSettings: () => void;
  selection: string;
  chatEnd: React.RefObject<HTMLDivElement | null>;
}) {
  const options = modelOptions(provider);
  const efforts = options.find((option) => option.value === model)?.efforts ?? ["high"];
  return (
    <section className="agent-panel">
      <div className="agent-header">
        <div className="agent-conversation-controls">
          <button className="agent-title" title="Conversation history" aria-expanded={sessionMenuOpen} onClick={() => setSessionMenuOpen(!sessionMenuOpen)}>
            <Bot size={16} /><span>{activeSession?.title ?? "Writing agent"}</span><ChevronDown size={12} />
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
        <div className="session-menu">
          <div className="session-menu-heading"><span>Conversations</span><button onClick={onNewSession}><Plus size={13} /> New</button></div>
          <div className="session-list">
            {sessions.map((session) => (
              <div key={session.id} className={session.id === activeSession?.id ? "active" : ""}>
                <button className="session-open" onClick={() => onOpenSession(session.id)}>
                  <strong>{session.title}</strong>
                  <small>{modelLabel(session.provider, session.model || defaultModel(session.provider))} · {session.messageCount} messages · {relativeTime(session.updatedAt)}</small>
                </button>
                <button className="session-delete" title="Delete conversation" disabled={running} onClick={() => onDeleteSession(session.id)}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="chat-list">
        {messages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            {message.role === "agent" && <div className="message-avatar"><Sparkles size={13} /></div>}
            <div className="message-body">
              <p>{message.text}</p>
              {!!message.files?.length && <div className="changed-files">{message.files.map((file) => <span key={file}><FileCode2 size={11} />{file}</span>)}</div>}
            </div>
          </div>
        ))}
        {running && (
          <div className="chat-message agent">
            <div className="message-avatar"><Sparkles size={13} /></div>
            <div className="thinking"><span /><span /><span /><em>{provider === "claude" ? "Claude is writing…" : "Agent is writing…"}</em></div>
          </div>
        )}
        <div ref={chatEnd} />
      </div>
      <div className="composer-wrap">
        {selection && <div className="context-chip"><Code2 size={12} /> Selection · {selection.length} chars <button title="Selection follows the editor"><Check size={11} /></button></div>}
        <div className="composer">
          <textarea
            rows={3}
            placeholder="Ask the agent to write, revise, or reason…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <div className="composer-footer">
            <span>{modelLabel(provider, model)} · {effortLabel(reasoningEffort)}</span>
            <button onClick={onSend} disabled={running || !input.trim()}><Send size={14} /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

function CanvasToolbar(props: {
  mode: CanvasMode;
  setMode: (mode: CanvasMode) => void;
  activeFile: string;
  dirty: boolean;
  onHistory: () => void;
}) {
  return (
    <div className="canvas-toolbar">
      <div className="active-document"><FileCode2 size={14} /><span>{props.activeFile}</span>{props.dirty && <i />}</div>
      <div className="view-switcher">
        {(["source", "split", "pdf"] as CanvasMode[]).map((mode) => (
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
  setSource: (value: string) => void;
  setSelection: (value: string) => void;
  pdfUrl: string | null;
  paperMarkdown: string;
  activePaper: PaperSummary | null;
  citationKeys: string[];
}) {
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSplitRatio);
  const paperHtml = useMemo(
    () => DOMPurify.sanitize(marked.parse(props.paperMarkdown, { async: false }) as string),
    [props.paperMarkdown],
  );
  const editorExtensions = useMemo(
    () => [latex({ enableAutocomplete: false }), ...latexEditorExtensions(props.citationKeys)],
    [props.citationKeys],
  );
  if (props.mode === "paper") {
    return (
      <article className="paper-reader">
        <div className="paper-reader-title"><BookOpen size={15} /><span>{props.activePaper?.title ?? "Imported paper"}</span>{props.activePaper && <small>arXiv {props.activePaper.arxivId}</small>}</div>
        <div className="paper-content" dangerouslySetInnerHTML={{ __html: paperHtml }} />
      </article>
    );
  }
  const editor = (
    <div className="source-editor">
      <CodeMirror
        className="code-editor-root"
        value={props.source}
        height="100%"
        extensions={editorExtensions}
        onChange={props.setSource}
        onUpdate={(view) => {
          const range = view.state.selection.main;
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
    </div>
  );
  const preview = (
    <PdfPreview key={props.pdfUrl ?? "empty-pdf"} url={props.pdfUrl} />
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
      style={{ gridTemplateColumns: `minmax(220px, ${splitRatio}fr) 5px minmax(260px, ${1 - splitRatio}fr)` }}
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

function PdfPreview({ url }: { url: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [loading, setLoading] = useState(Boolean(url));
  const [pdfError, setPdfError] = useState("");

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

  const download = () => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "paper.pdf";
    anchor.click();
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
        <button className="pdf-download" title="Download PDF" onClick={download}><Download size={14} /></button>
      </div>
      <div className="pdf-scroll-area">
        {pdfError ? <div className="pdf-placeholder"><CircleAlert size={24} /><p>{pdfError}</p></div> : <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />}
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
            <button className={props.tab === "accounts" ? "active" : ""} onClick={() => props.setTab("accounts")}>Subscriptions</button>
            <button className={props.tab === "api" ? "active" : ""} onClick={() => props.setTab("api")}>API keys</button>
          </nav>
          <div className="settings-content">
            {props.tab === "appearance" && (
              <div className="settings-section">
                <h2>Appearance</h2>
                <p>These preferences apply across every project on this Mac.</p>
                <label>Interface font
                  <select value={props.appearance.uiFont} onChange={(event) => props.setAppearance({ ...props.appearance, uiFont: event.target.value })}>
                    <option value='"DM Sans", -apple-system, sans-serif'>DM Sans</option>
                    <option value='Inter, -apple-system, sans-serif'>Inter</option>
                    <option value='-apple-system, BlinkMacSystemFont, sans-serif'>System</option>
                    <option value='"Avenir Next", sans-serif'>Avenir Next</option>
                  </select>
                </label>
                <label>LaTeX editor font
                  <select value={props.appearance.editorFont} onChange={(event) => props.setAppearance({ ...props.appearance, editorFont: event.target.value })}>
                    <option value='"JetBrains Mono", monospace'>JetBrains Mono</option>
                    <option value='"SFMono-Regular", Consolas, monospace'>SF Mono</option>
                    <option value='"Fira Code", monospace'>Fira Code</option>
                    <option value='Menlo, monospace'>Menlo</option>
                  </select>
                </label>
                <div className="settings-range">
                  <div><label htmlFor="editor-font-size">Editor font size</label><output>{props.appearance.editorFontSize}px</output></div>
                  <input id="editor-font-size" type="range" min="10" max="18" step="1" value={props.appearance.editorFontSize} onChange={(event) => props.setAppearance({ ...props.appearance, editorFontSize: Number(event.target.value) })} />
                </div>
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
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: frontier },
        { value: "claude-fable-5", label: "Claude Fable 5", efforts: frontier },
      ];
    case "anthropic-api":
      return [
        { value: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: frontier },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: frontier },
        { value: "claude-fable-5", label: "Claude Fable 5", efforts: frontier },
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
    if (model === "fable") return "claude-fable-5";
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

function effortLabel(value: ReasoningEffort): string {
  return value === "xhigh" ? "extra high" : value;
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
    editorFont: '"JetBrains Mono", monospace',
    editorFontSize: 13,
  };
  try {
    const value = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "null") as Partial<AppearanceSettings> | null;
    return {
      uiFont: typeof value?.uiFont === "string" ? value.uiFont : defaults.uiFont,
      editorFont: typeof value?.editorFont === "string" ? value.editorFont : defaults.editorFont,
      editorFontSize: clamp(Number(value?.editorFontSize) || defaults.editorFontSize, 10, 18),
    };
  } catch {
    return defaults;
  }
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
