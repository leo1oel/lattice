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
import { ModalDialog } from "./components/ui/modal-dialog";
import {
  type CloneTarget,
  type OverleafLink,
  type OverleafLoginPoll,
  type OverleafProject,
  type OverleafStatus,
} from "./app-types";
import { confirmAction, relativeTime, toMessage } from "./app-utils";
import { type OverleafRemoteDelete, type OverleafSyncMode } from "./app-settings";
import "./overleaf-connect.css";

const DEFAULT_OVERLEAF_HOST = "https://www.overleaf.com";

type OverleafLogin = {
  pending: boolean;
  error: string | null;
  notice: string | null;
  /** Guidance shown when sign-in has been pending long enough to look stuck. */
  hint: string | null;
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
  const [hint, setHint] = useState<string | null>(null);
  const attempts = useRef(0);
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
      // Signing in takes a few seconds, but it should never take half a minute.
      // Rather than spin forever, say what to do next (and why, when the
      // backend got far enough to have a reason).
      attempts.current += 1;
      if (attempts.current >= 20) {
        setHint(
          result.detail
            ? `Still not connected: ${result.detail}`
            : "Still waiting. If you are already signed in to Overleaf in that window, "
              + "open Advanced options below and paste your session cookie instead.",
        );
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
    setHint(null);
    attempts.current = 0;
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

  return { pending, error, notice, hint, begin, cancel };
}

function LoginWaitingRow(props: { onCancel: () => void; hint?: string | null }) {
  return (
    <>
      <div className="overleaf-waiting">
        <LoaderCircle className="spin" size={15} />
        <span>Waiting for you to sign in in the Overleaf window…</span>
        <button type="button" className="text-button" onClick={props.onCancel}>Cancel</button>
      </div>
      {props.hint && <p className="overleaf-hint">{props.hint}</p>}
    </>
  );
}

/** Settings → Overleaf tab: connection status, sign-in, and the manual fallback. */
export function OverleafSettingsSection(props: {
  syncMode: OverleafSyncMode;
  onSyncModeChange: (mode: OverleafSyncMode) => void;
  /** What deleting a file here should do to Overleaf's copy. */
  remoteDelete: OverleafRemoteDelete;
  onRemoteDeleteChange: (mode: OverleafRemoteDelete) => void;
  /** State of the live editing channel, so a failed start is visible here. */
  channel: "off" | "connecting" | "live" | "error";
  channelDetail: string | null;
  /**
   * Unlinking here has to reach the rest of the app: the toolbar, the live
   * channel, chat and collaborators all key off the project link, and without
   * this they kept running against a project that was no longer linked.
   */
  onLinkChanged: () => void;
}) {
  const [status, setStatus] = useState<OverleafStatus | null>(null);
  const [link, setLink] = useState<OverleafLink | null>(null);
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
    // Whether the *open project* is tied to an Overleaf project is separate
    // from whether the account is connected, and only the former can be
    // stopped per project.
    try {
      setLink(await invoke<OverleafLink | null>("overleaf_link"));
    } catch {
      setLink(null);
    }
    setLoading(false);
  }, []);

  /**
   * Pausing keeps the link and everything it needs to start again, so
   * resuming is an ordinary sync: whatever changed on either side while it was
   * paused merges against the copy from the last sync. Removing the link
   * instead would throw that common ancestor away and leave reconnecting able
   * to offer nothing better than a conflict copy of every file that differs.
   */
  const setPaused = async (paused: boolean) => {
    if (paused && !await confirmAction(
      "Pause syncing with Overleaf?\n\n"
      + "Nothing is sent or fetched until you resume, and live editing, chat and "
      + "collaborators stop. Every file stays where it is on both sides.\n\n"
      + "Resuming picks up where this left off: edits made on either side while it was "
      + "paused are merged, not overwritten.",
    )) return;
    setActionError(null);
    try {
      await invoke("overleaf_set_paused", { paused });
      setLink((current) => (current ? { ...current, paused } : current));
      props.onLinkChanged();
    } catch (reason) {
      setActionError(toMessage(reason));
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async () => {
    setActionError(null);
    try {
      await invoke("overleaf_disconnect");
      await load();
      // Signing out ends the live channel too, so the rest of the app has to
      // re-read where it stands.
      props.onLinkChanged();
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
          <button type="button" className="secondary-button" onClick={() => void disconnect()}>Sign out</button>
        </div>
      )}
      {!loading && !loadError && status && !status.connected && (
        login.pending ? (
          <LoginWaitingRow onCancel={login.cancel} hint={login.hint} />
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
      {link && (
        <div className="overleaf-status-row">
          <span className={`overleaf-dot ${link.paused ? "paused" : "connected"}`} aria-hidden="true" />
          <div className="overleaf-status-text">
            <strong>
              {link.paused
                ? `Syncing with “${link.projectName}” is paused`
                : `This project syncs with “${link.projectName}”`}
            </strong>
            <small>
              {link.paused
                ? "Nothing is sent or fetched until you resume."
                : link.lastSync ? `Last synced ${relativeTime(link.lastSync)}` : "Not synced yet"}
            </small>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void setPaused(!link.paused)}
          >
            {link.paused ? "Resume syncing" : "Pause syncing"}
          </button>
        </div>
      )}
      <div className="overleaf-mode">
        <h3>Keeping in step</h3>
        <label className="overleaf-mode-option">
          <input
            type="radio"
            name="overleaf-sync-mode"
            checked={props.syncMode === "live"}
            onChange={() => props.onSyncModeChange("live")}
          />
          <span>
            <strong>Live sync</strong>
            <small>
              Edits travel through Overleaf's own editing channel, so you and anyone in the
              browser see each other's typing as it happens. Figures and new files follow on a
              slower check in the background.
            </small>
            {props.syncMode === "live" && (
              <small className={`overleaf-channel overleaf-channel-${props.channel}`}>
                {props.channel === "live" && "Connected to Overleaf's editing channel."}
                {props.channel === "connecting" && "Connecting to Overleaf's editing channel…"}
                {props.channel === "off" && "Open a linked project to start editing live."}
                {props.channel === "error"
                  && `Live editing could not start${props.channelDetail ? `: ${props.channelDetail}` : ""}. Your project still syncs.`}
              </small>
            )}
          </span>
        </label>
        <label className="overleaf-mode-option">
          <input
            type="radio"
            name="overleaf-sync-mode"
            checked={props.syncMode === "manual"}
            onChange={() => props.onSyncModeChange("manual")}
          />
          <span>
            <strong>Manual</strong>
            <small>
              Nothing moves until you press the sync button. A dot appears on it when Overleaf
              has changes waiting, and every sync is recorded in Versions so you can read the
              diff and roll back.
            </small>
          </span>
        </label>
      </div>
      <div className="overleaf-mode">
        <h3>When you delete a file here</h3>
        {([
          {
            id: "ask" as const,
            title: "Ask me",
            blurb: "A sync that finds a file missing here offers to remove it from Overleaf too.",
          },
          {
            id: "always" as const,
            title: "Delete it there too",
            blurb: "Keeps both sides identical. Overleaf's own history still has the file if it was a mistake.",
          },
          {
            id: "never" as const,
            title: "Leave it on Overleaf",
            blurb: "Nothing is ever removed from the shared project from here. The two sides stay different.",
          },
        ]).map((option) => (
          <label className="overleaf-mode-option" key={option.id}>
            <input
              type="radio"
              name="overleaf-remote-delete"
              checked={props.remoteDelete === option.id}
              onChange={() => props.onRemoteDeleteChange(option.id)}
            />
            <span>
              <strong>{option.title}</strong>
              <small>{option.blurb}</small>
            </span>
          </label>
        ))}
      </div>

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

  const clone = async (project: OverleafProject) => {
    if (cloning) return;
    setCloning(project);
    setCloneError(null);
    try {
      // A folder of this name already holding files, with no link to any
      // Overleaf project, is what Stop syncing leaves behind. Downloading a
      // second copy beside it strands whatever was written in the meantime in
      // a folder nothing points at, so this asks rather than choosing.
      let adopt = false;
      const target = await invoke<CloneTarget>("overleaf_clone_target", {
        projectId: project.id,
        name: project.name,
      }).catch(() => null);
      if (target?.kind === "occupied") {
        adopt = await confirmAction(
          `“${target.folder}” already has files in it and isn’t linked to Overleaf.\n\n`
          + "OK — link that folder to this Overleaf project. Files that differ are kept "
          + "both ways: Overleaf’s version takes the filename and yours is saved beside "
          + "it as “name (local conflict …)”. Nothing is overwritten or thrown away.\n\n"
          + "Cancel — download a separate copy into a new folder and leave that one alone.",
        );
      }
      const root = await invoke<string>("overleaf_clone_project", {
        projectId: project.id,
        name: project.name,
        adopt,
      });
      setCloning(null);
      props.onCloned(root);
      onClose();
    } catch (reason) {
      setCloning(null);
      // A project that is already downloaded now simply opens, so there is no
      // longer a "move the folder aside yourself" case to explain.
      setCloneError(toMessage(reason));
    }
  };

  if (!props.open) return null;

  const query = search.trim().toLowerCase();
  const visible = (projects ?? [])
    .filter((project) => showArchived || (!project.archived && !project.trashed))
    .filter((project) => !query || [project.name, project.ownerName ?? "", project.ownerEmail ?? ""]
      .some((value) => value.toLowerCase().includes(query)));

  return (
    <ModalDialog label="Open from Overleaf" onClose={onClose} closeDisabled={Boolean(cloning)}>
      <div className="modal overleaf-picker-modal">
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
              <LoginWaitingRow onCancel={login.cancel} hint={login.hint} />
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
    </ModalDialog>
  );
}
