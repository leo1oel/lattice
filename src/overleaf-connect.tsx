/**
 * Overleaf connection UI: the Settings → Overleaf section and the
 * "Open from Overleaf" project picker dialog.
 *
 * Both talk to the Rust `overleaf` bridge through Tauri commands and are
 * written for complete novices: every state (disconnected, waiting for the
 * sign-in window, loading, empty, error, downloading) carries plain-language
 * guidance about what is happening and what to do next.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, LoaderCircle, Search, X } from "lucide-react";
import { MotionButton } from "./motion";
import {
  type OverleafLoginPoll,
  type OverleafProject,
  type OverleafStatus,
} from "./app-types";
import { relativeTime, toMessage } from "./app-utils";
import "./overleaf-connect.css";

const DEFAULT_OVERLEAF_HOST = "https://www.overleaf.com";

type OverleafLogin = {
  pending: boolean;
  error: string | null;
  notice: string | null;
  begin: () => void;
  cancel: () => void;
};

/**
 * Shared begin-login + poll loop. `overleaf_begin_login` opens a sign-in
 * window and returns immediately; we then poll `overleaf_poll_login` (once
 * right away, then every 1.5s) until the backend reports connected or
 * cancelled. The settings section and the picker both use this so novices
 * can connect from either place without being bounced around the app.
 */
function useOverleafLogin(onConnected: (session: OverleafStatus) => void): OverleafLogin {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(false);
  const connectedRef = useRef(onConnected);
  useEffect(() => {
    connectedRef.current = onConnected;
  });

  // Stop polling when the component unmounts (e.g. the dialog closes).
  useEffect(() => () => {
    active.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const stop = useCallback(() => {
    active.current = false;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setPending(false);
  }, []);

  const poll = useCallback(async () => {
    if (!active.current) return;
    try {
      const result = await invoke<OverleafLoginPoll>("overleaf_poll_login");
      if (!active.current) return;
      if (result.status === "connected" && result.session) {
        stop();
        connectedRef.current(result.session);
        return;
      }
      if (result.status === "cancelled") {
        stop();
        setNotice("Sign-in was cancelled. You can try again whenever you’re ready.");
        return;
      }
      timer.current = setTimeout(() => void poll(), 1500);
    } catch (reason) {
      if (!active.current) return;
      stop();
      setError(toMessage(reason));
    }
  }, [stop]);

  const begin = useCallback(() => {
    if (active.current) return;
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        await invoke("overleaf_begin_login");
        active.current = true;
        setPending(true);
        void poll();
      } catch (reason) {
        setError(toMessage(reason));
      }
    })();
  }, [poll]);

  const cancel = useCallback(() => {
    stop();
    setNotice("Sign-in was cancelled. You can try again whenever you’re ready.");
  }, [stop]);

  return { pending, error, notice, begin, cancel };
}

function LoginWaitingRow(props: { onCancel: () => void }) {
  return (
    <div className="overleaf-waiting">
      <LoaderCircle className="spin" size={15} />
      <span>Waiting for you to sign in in the Overleaf window…</span>
      <button type="button" className="text-button" onClick={props.onCancel}>Cancel</button>
    </div>
  );
}

/** Settings → Overleaf tab: connection status, sign-in, and the manual fallback. */
export function OverleafSettingsSection() {
  const [status, setStatus] = useState<OverleafStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [host, setHost] = useState(DEFAULT_OVERLEAF_HOST);
  const [cookie, setCookie] = useState("");
  const [applying, setApplying] = useState(false);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [advancedNotice, setAdvancedNotice] = useState<string | null>(null);
  const login = useOverleafLogin((session) => setStatus(session));

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await invoke<OverleafStatus>("overleaf_status");
      setStatus(result);
      if (result.host) setHost(result.host);
    } catch (reason) {
      setLoadError(toMessage(reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async () => {
    setActionError(null);
    try {
      await invoke("overleaf_disconnect");
      await load();
    } catch (reason) {
      setActionError(toMessage(reason));
    }
  };

  const applyCookie = async () => {
    if (!cookie.trim() || applying) return;
    setApplying(true);
    setAdvancedError(null);
    setAdvancedNotice(null);
    try {
      const result = await invoke<OverleafStatus>("overleaf_store_cookie", {
        host: host.trim() || DEFAULT_OVERLEAF_HOST,
        cookie: cookie.trim(),
      });
      setStatus(result);
      if (result.connected) {
        setCookie("");
        setAdvancedNotice(`Connected to ${result.host}.`);
      } else {
        setAdvancedError("Overleaf didn’t accept that cookie. Make sure you’re signed in to Overleaf in your browser, then copy the Cookie header value again.");
      }
    } catch (reason) {
      setAdvancedError(toMessage(reason));
    }
    setApplying(false);
  };

  return (
    <div className="settings-section">
      <h2>Overleaf</h2>
      <p>Connect your Overleaf account to open and sync your Overleaf projects directly in Lattice.</p>
      {loading && <p className="settings-empty">Checking your Overleaf connection…</p>}
      {!loading && loadError && (
        <>
          <p className="overleaf-error" role="alert">{loadError}</p>
          <div className="overleaf-retry-row">
            <button type="button" className="secondary-button" onClick={() => void load()}>Try again</button>
          </div>
        </>
      )}
      {!loading && !loadError && status?.connected && (
        <div className="overleaf-status-row">
          <span className="overleaf-dot connected" aria-hidden="true" />
          <div className="overleaf-status-text">
            <strong>Connected as {status.email ?? status.name ?? "your Overleaf account"}</strong>
            <small>{status.host}</small>
          </div>
          <button type="button" className="secondary-button" onClick={() => void disconnect()}>Disconnect</button>
        </div>
      )}
      {!loading && !loadError && status && !status.connected && (
        login.pending ? (
          <LoginWaitingRow onCancel={login.cancel} />
        ) : (
          <div className="overleaf-connect-row">
            <MotionButton className="primary-button" onClick={login.begin}>
              <Cloud size={15} /> Connect to Overleaf
            </MotionButton>
            <p className="overleaf-hint">
              A secure Overleaf sign-in window will open. Lattice never sees your password — it only keeps the session Overleaf creates for you.
            </p>
          </div>
        )
      )}
      {login.error && <p className="overleaf-error" role="alert">{login.error}</p>}
      {login.notice && <p className="overleaf-hint">{login.notice}</p>}
      {actionError && <p className="overleaf-error" role="alert">{actionError}</p>}
      <details className="overleaf-advanced">
        <summary>Advanced options</summary>
        <p className="overleaf-hint">
          Only needed if your lab runs its own Overleaf server (Community or Server Pro), or if the sign-in window doesn’t work.
        </p>
        <label>Server address
          <input
            type="text"
            value={host}
            placeholder={DEFAULT_OVERLEAF_HOST}
            onChange={(event) => setHost(event.target.value)}
          />
        </label>
        <label>Session cookie
          <textarea
            value={cookie}
            placeholder="overleaf_session2=…"
            onChange={(event) => setCookie(event.target.value)}
          />
        </label>
        <p className="overleaf-hint">
          Paste the Cookie header value from your browser’s DevTools if automatic sign-in doesn’t work.
        </p>
        {advancedError && <p className="overleaf-error" role="alert">{advancedError}</p>}
        {advancedNotice && <p className="settings-notice">{advancedNotice}</p>}
        <div className="overleaf-advanced-actions">
          <MotionButton
            className="primary-button"
            disabled={!cookie.trim() || applying}
            onClick={() => void applyCookie()}
          >
            {applying ? "Applying…" : "Apply"}
          </MotionButton>
        </div>
      </details>
    </div>
  );
}

/**
 * "Open from Overleaf" modal: connect (if needed), browse and search your
 * Overleaf projects, and download one as a local Lattice project.
 */
export function OverleafPickerDialog(props: {
  open: boolean;
  onClose: () => void;
  onCloned: (root: string) => void;
  onOpenSettings: () => void;
}) {
  const [status, setStatus] = useState<OverleafStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [projects, setProjects] = useState<OverleafProject[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [cloning, setCloning] = useState<OverleafProject | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const login = useOverleafLogin((session) => setStatus(session));
  const { onClose } = props;

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      setStatus(await invoke<OverleafStatus>("overleaf_status"));
    } catch (reason) {
      setStatusError(toMessage(reason));
    }
    setStatusLoading(false);
  }, []);

  const loadProjects = useCallback(async () => {
    setProjects(null);
    setProjectsError(null);
    try {
      setProjects(await invoke<OverleafProject[]>("overleaf_list_projects"));
    } catch (reason) {
      setProjectsError(toMessage(reason));
    }
  }, []);

  // Fresh state on every open, then check the connection.
  useEffect(() => {
    if (!props.open) return;
    setSearch("");
    setShowArchived(false);
    setSelected(null);
    setCloning(null);
    setCloneError(null);
    setProjects(null);
    setProjectsError(null);
    void loadStatus();
  }, [props.open, loadStatus]);

  // Once connected (on open, or right after the in-dialog login), list projects.
  useEffect(() => {
    if (props.open && status?.connected) void loadProjects();
  }, [props.open, status?.connected, loadProjects]);

  // Escape closes — unless a download is in flight, where closing would be confusing.
  useEffect(() => {
    if (!props.open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !cloning) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [props.open, cloning, onClose]);

  const clone = async (project: OverleafProject) => {
    if (cloning) return;
    setCloning(project);
    setCloneError(null);
    try {
      const root = await invoke<string>("overleaf_clone_project", {
        projectId: project.id,
        name: project.name,
      });
      setCloning(null);
      props.onCloned(root);
      onClose();
    } catch (reason) {
      setCloning(null);
      const text = toMessage(reason);
      setCloneError(/already exist/i.test(text)
        ? `${text} It looks like this project was already downloaded — open that copy with “Open folder” or from your recent projects, or move the existing folder aside to download it again.`
        : text);
    }
  };

  if (!props.open) return null;

  const query = search.trim().toLowerCase();
  const visible = (projects ?? [])
    .filter((project) => showArchived || (!project.archived && !project.trashed))
    .filter((project) => !query || [project.name, project.ownerName ?? "", project.ownerEmail ?? ""]
      .some((value) => value.toLowerCase().includes(query)));

  return (
    <div className="modal-backdrop" onMouseDown={() => { if (!cloning) onClose(); }}>
      <div className="modal overleaf-picker-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="overleaf-picker-header">
          <div className="modal-icon"><Cloud size={19} /></div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            title={cloning ? "You can close this once the download finishes" : "Close"}
            disabled={Boolean(cloning)}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <h2>Open from Overleaf</h2>
        {statusLoading && (
          <div className="overleaf-loading">
            <LoaderCircle className="spin" size={15} />
            <span>Checking your Overleaf connection…</span>
          </div>
        )}
        {!statusLoading && statusError && (
          <>
            <p className="overleaf-error" role="alert">{statusError}</p>
            <div className="overleaf-retry-row">
              <button type="button" className="secondary-button" onClick={() => void loadStatus()}>Retry</button>
            </div>
          </>
        )}
        {!statusLoading && !statusError && status && !status.connected && (
          <>
            <p>
              Your Overleaf account isn’t connected yet. Connect it once, and every project from your Overleaf account will show up here, ready to open in Lattice.
            </p>
            {login.pending ? (
              <LoginWaitingRow onCancel={login.cancel} />
            ) : (
              <MotionButton className="primary-button" onClick={login.begin}>
                <Cloud size={15} /> Connect to Overleaf
              </MotionButton>
            )}
            {login.error && <p className="overleaf-error" role="alert">{login.error}</p>}
            {login.notice && <p className="overleaf-hint">{login.notice}</p>}
            <button
              type="button"
              className="text-button overleaf-advanced-link"
              onClick={() => { onClose(); props.onOpenSettings(); }}
            >
              Advanced options
            </button>
          </>
        )}
        {!statusLoading && !statusError && status?.connected && (
          <>
            <p>Pick a project to download. Lattice keeps a local copy you can edit offline and sync back to Overleaf later.</p>
            <div className="overleaf-picker-controls">
              <div className="overleaf-search">
                <Search size={13} />
                <input
                  type="text"
                  aria-label="Search Overleaf projects"
                  placeholder="Search by project or owner…"
                  autoFocus
                  value={search}
                  disabled={Boolean(cloning)}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <label className="overleaf-checkbox">
                <input
                  type="checkbox"
                  checked={showArchived}
                  disabled={Boolean(cloning)}
                  onChange={(event) => setShowArchived(event.target.checked)}
                />
                <span>Show archived</span>
              </label>
            </div>
            {projectsError && (
              <>
                <p className="overleaf-error" role="alert">{projectsError}</p>
                <div className="overleaf-retry-row">
                  <button type="button" className="secondary-button" onClick={() => void loadProjects()}>Retry</button>
                </div>
              </>
            )}
            {!projectsError && projects === null && (
              <div className="overleaf-loading">
                <LoaderCircle className="spin" size={15} />
                <span>Loading your Overleaf projects…</span>
              </div>
            )}
            {!projectsError && projects !== null && visible.length === 0 && (
              <p className="overleaf-empty">
                {projects.length === 0
                  ? "No projects in this account yet. Create one on Overleaf and it will appear here."
                  : query
                    ? "No projects match your search."
                    : "All of your projects are archived or trashed. Tick “Show archived” to see them."}
              </p>
            )}
            {!projectsError && projects !== null && visible.length > 0 && (
              <ul className="overleaf-project-list" aria-label="Overleaf projects">
                {visible.map((project) => (
                  <li
                    key={project.id}
                    className={`overleaf-project-row${selected === project.id ? " selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="overleaf-project-main"
                      disabled={Boolean(cloning)}
                      onClick={() => { setSelected(project.id); setCloneError(null); }}
                    >
                      <span className="overleaf-project-name">
                        {project.name}
                        {project.trashed
                          ? <span className="overleaf-badge">Trashed</span>
                          : project.archived
                            ? <span className="overleaf-badge">Archived</span>
                            : null}
                      </span>
                      <span className="overleaf-project-meta">
                        {project.ownerName || project.ownerEmail || "Unknown owner"}
                        {" · "}
                        {project.lastUpdated ? `updated ${relativeTime(project.lastUpdated)}` : "last update unknown"}
                      </span>
                    </button>
                    {selected === project.id && (
                      cloning?.id === project.id
                        ? <LoaderCircle className="spin overleaf-row-spinner" size={15} />
                        : (
                          <MotionButton
                            className="primary-button overleaf-open-button"
                            disabled={Boolean(cloning)}
                            onClick={() => void clone(project)}
                          >
                            Open
                          </MotionButton>
                        )
                    )}
                  </li>
                ))}
              </ul>
            )}
            {cloning && (
              <div className="overleaf-progress">
                <LoaderCircle className="spin" size={15} />
                <span>Downloading {cloning.name} from Overleaf… this can take a minute for large projects.</span>
              </div>
            )}
            {cloneError && <p className="overleaf-error" role="alert">{cloneError}</p>}
            <p className="overleaf-footer-note">
              Changes sync when you press the sync button in the toolbar — Lattice keeps a local copy that works offline.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
