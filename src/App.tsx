import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
import { latex } from "codemirror-lang-latex";
import DOMPurify from "dompurify";
import { gsap } from "gsap";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  History,
  KeyRound,
  Library,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { marked } from "marked";
import "./App.css";

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
  messages: ChatMessage[];
};

type AgentSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  provider: AgentProvider;
  messageCount: number;
};

type CanvasMode = "source" | "pdf" | "split" | "paper";
type Theme = "light" | "dark";
type AgentProvider = "codex" | "claude" | "openai-api" | "anthropic-api";
type RecentProject = { name: string; path: string };
type PanelKind = "navigator" | "agent";
type PanelWidths = { navigator: number; agent: number };

const RECENT_PROJECTS_KEY = "lattice.recent-projects.v1";
const PANEL_WIDTHS_KEY = "lattice.panel-widths.v1";

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
  const [activePaper, setActivePaper] = useState<PaperSummary | null>(null);
  const [paperMarkdown, setPaperMarkdown] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(defaultWelcomeMessages);
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [agentInput, setAgentInput] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [agentRunning, setAgentRunning] = useState(false);
  const [importInput, setImportInput] = useState("");
  const [importing, setImporting] = useState(false);
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
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
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
    setPapers(await invoke<PaperSummary[]>("list_papers"));
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
      setPapers(await invoke<PaperSummary[]>("list_papers"));
      setHistory(await invoke<HistoryItem[]>("list_history"));
      let sessionList = await invoke<AgentSessionSummary[]>("list_agent_sessions");
      const session = sessionList.length
        ? await invoke<AgentSession>("read_agent_session", { sessionId: sessionList[0].id })
        : await invoke<AgentSession>("create_agent_session", { provider: "codex" });
      if (!sessionList.length) sessionList = await invoke<AgentSessionSummary[]>("list_agent_sessions");
      setAgentSessions(sessionList);
      setActiveSession(session);
      setMessages(session.messages);
      setProvider(session.provider);
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

  const refreshAgentSessions = useCallback(async () => {
    setAgentSessions(await invoke<AgentSessionSummary[]>("list_agent_sessions"));
  }, []);

  const newAgentSession = useCallback(async () => {
    if (agentRunning) return;
    try {
      const session = await invoke<AgentSession>("create_agent_session", { provider });
      setActiveSession(session);
      setMessages(session.messages);
      setSessionMenuOpen(false);
      await refreshAgentSessions();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [agentRunning, provider, refreshAgentSessions]);

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
          : await invoke<AgentSession>("create_agent_session", { provider });
        if (!remaining.length) remaining = await invoke<AgentSessionSummary[]>("list_agent_sessions");
        setActiveSession(next);
        setMessages(next.messages);
        setProvider(next.provider);
      }
      setAgentSessions(remaining);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeSession, agentRunning, provider]);

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
      if (!session) session = await invoke<AgentSession>("create_agent_session", { provider });
      session = await invoke<AgentSession>("save_agent_session", {
        session: { ...session, provider, messages: pendingMessages },
      });
      setActiveSession(session);
      await refreshAgentSessions();
      if (!(await save())) throw new Error("Save the current file before running the agent.");
      const result = await invoke<AgentResult>("run_agent", {
        provider,
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
        session: { ...session, provider, messages: completedMessages },
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
            session: { ...session, provider, messages: failedMessages },
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
  }, [activeFile, activeSession, agentInput, agentRunning, compile, loadFile, messages, provider, refreshAgentSessions, refreshHistory, refreshProject, save, selection]);

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

  const openApiSettings = useCallback(async () => {
    try {
      await refreshApiKeys();
      setApiSettingsOpen(true);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshApiKeys]);

  const saveApiKey = useCallback(async () => {
    try {
      await invoke("save_api_key", { provider: apiProvider, key: apiKey });
      setApiKey("");
      await refreshApiKeys();
      setProvider(apiProvider === "openai" ? "openai-api" : "anthropic-api");
      setApiSettingsOpen(false);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [apiKey, apiProvider, refreshApiKeys]);

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

  if (!project) {
    return (
      <Welcome
        busyLabel={busyLabel}
        createOpen={createOpen}
        error={error}
        projectName={projectName}
        setCreateOpen={setCreateOpen}
        setProjectName={setProjectName}
        onCreate={createProject}
        onOpen={chooseExisting}
        theme={theme}
        toggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      />
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
              papers={papers}
              activePaper={activePaper}
              onFile={loadFile}
              onPaper={openPaper}
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
          setProvider={setProvider}
          running={agentRunning}
          onSend={sendToAgent}
          onApiSettings={openApiSettings}
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
          />
        </section>
      </main>

      {historyOpen && (
        <HistoryDrawer history={history} onClose={() => setHistoryOpen(false)} onRevert={revert} onDelete={deleteHistory} />
      )}
      {apiSettingsOpen && (
        <ApiSettings
          provider={apiProvider}
          setProvider={setApiProvider}
          apiKey={apiKey}
          setApiKey={setApiKey}
          configured={Boolean(apiKeyStatus[apiProvider])}
          onSave={saveApiKey}
          onDelete={deleteApiKey}
          onClose={() => {
            setApiSettingsOpen(false);
            setApiKey("");
          }}
        />
      )}
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
  theme: Theme;
  toggleTheme: () => void;
}) {
  return (
    <div className="welcome-screen">
      <div className="welcome-titlebar" data-tauri-drag-region>
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
  papers: PaperSummary[];
  activePaper: PaperSummary | null;
  onFile: (path: string) => void;
  onPaper: (paper: PaperSummary) => void;
  importInput: string;
  setImportInput: (value: string) => void;
  onImport: () => void;
  importing: boolean;
}) {
  return (
    <aside className="navigator">
      <div className="navigator-section">
        <div className="section-heading"><span>Project</span></div>
        <div className="file-tree">
          {props.files.map((node) => <TreeNode key={node.path} node={node} activeFile={props.activeFile} onFile={props.onFile} />)}
        </div>
      </div>
      <div className="navigator-section papers-section">
        <div className="section-heading">
          <span>Papers</span>
          <span className="count-badge">{props.papers.length}</span>
        </div>
        <div className="paper-list">
          {props.papers.map((paper) => (
            <button key={paper.arxivId} title={paper.title} className={props.activePaper?.arxivId === paper.arxivId ? "active" : ""} onClick={() => props.onPaper(paper)}>
              <BookOpen size={14} />
              <span><strong>{paper.title}</strong><small>arXiv {paper.arxivId}</small></span>
            </button>
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

function TreeNode({ node, activeFile, onFile }: { node: FileNode; activeFile: string; onFile: (path: string) => void }) {
  const [open, setOpen] = useState(true);
  if (node.kind === "directory") {
    return (
      <div className="tree-directory">
        <button className="tree-row" onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={14} /> <span>{node.name}</span>
        </button>
        {open && <div className="tree-children">{node.children.map((child) => <TreeNode key={child.path} node={child} activeFile={activeFile} onFile={onFile} />)}</div>}
      </div>
    );
  }
  const Icon = node.kind === "tex" ? FileCode2 : node.kind === "bib" ? Library : File;
  if (node.kind === "figure") {
    return (
      <div className="tree-row asset-row" title="Binary assets are listed here but are not opened in the source editor.">
        <span className="tree-spacer" /><Icon size={14} /><span>{node.name}</span>
      </div>
    );
  }
  return (
    <button className={`tree-row ${activeFile === node.path ? "active" : ""}`} onClick={() => onFile(node.path)}>
      <span className="tree-spacer" /><Icon size={14} /><span>{node.name}</span>
    </button>
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
  running: boolean;
  onSend: () => void;
  onApiSettings: () => void;
  selection: string;
  chatEnd: React.RefObject<HTMLDivElement | null>;
}) {
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
          <select value={provider} disabled={running} onChange={(event) => setProvider(event.target.value as AgentProvider)}>
            <option value="codex">Codex subscription</option>
            <option value="claude">Claude subscription</option>
            <option value="openai-api">OpenAI API</option>
            <option value="anthropic-api">Anthropic API</option>
          </select>
          <button onClick={onApiSettings} title="API key settings"><KeyRound size={14} /></button>
        </div>
      </div>
      {sessionMenuOpen && (
        <div className="session-menu">
          <div className="session-menu-heading"><span>Conversations</span><button onClick={onNewSession}><Plus size={13} /> New</button></div>
          <div className="session-list">
            {sessions.map((session) => (
              <div key={session.id} className={session.id === activeSession?.id ? "active" : ""}>
                <button className="session-open" onClick={() => onOpenSession(session.id)}>
                  <strong>{session.title}</strong>
                  <small>{providerLabel(session.provider)} · {session.messageCount} messages · {relativeTime(session.updatedAt)}</small>
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
            <span>{providerLabel(provider)}</span>
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
}) {
  const paperHtml = useMemo(
    () => DOMPurify.sanitize(marked.parse(props.paperMarkdown, { async: false }) as string),
    [props.paperMarkdown],
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
        value={props.source}
        height="100%"
        extensions={[latex()]}
        onChange={props.setSource}
        onUpdate={(view) => {
          const range = view.state.selection.main;
          props.setSelection(range.empty ? "" : view.state.sliceDoc(range.from, range.to));
        }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: false,
        }}
      />
    </div>
  );
  const preview = (
    <div className="pdf-preview">
      {props.pdfUrl ? <iframe src={`${props.pdfUrl}#toolbar=0&navpanes=0`} title="Compiled paper" /> : <div className="pdf-placeholder"><FileText size={28} /><p>Build the project to preview the paper.</p></div>}
    </div>
  );
  if (props.mode === "source") return editor;
  if (props.mode === "pdf") return preview;
  return <div className="split-canvas">{editor}{preview}</div>;
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

function ApiSettings(props: {
  provider: "openai" | "anthropic";
  setProvider: (provider: "openai" | "anthropic") => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  configured: boolean;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal api-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><KeyRound size={20} /></div>
        <h2>API key settings</h2>
        <p>Keys are stored in macOS Keychain and are never written to the project or browser storage.</p>
        <label>
          Provider
          <select value={props.provider} onChange={(event) => props.setProvider(event.target.value as "openai" | "anthropic")}>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label>
          <span className="key-label">API key {props.configured && <span className="configured-label"><Check size={11} /> Configured</span>}</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={props.configured ? "Enter a replacement key" : "Paste API key"}
            value={props.apiKey}
            onChange={(event) => props.setApiKey(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && props.apiKey.trim() && props.onSave()}
          />
        </label>
        <div className="modal-actions api-actions">
          {props.configured && <button className="delete-key-button" onClick={props.onDelete}><Trash2 size={13} /> Remove</button>}
          <span />
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <button className="primary-button" onClick={props.onSave} disabled={!props.apiKey.trim()}>Save key</button>
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

function providerLabel(provider: AgentProvider): string {
  switch (provider) {
    case "codex": return "Local Codex subscription";
    case "claude": return "Local Claude subscription";
    case "openai-api": return "OpenAI API · GPT-5.6";
    case "anthropic-api": return "Anthropic API · Sonnet 5";
  }
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
