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
import { Cloud } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { InfinityLoader, ReloadButton } from "./components/ui/activity-icons";
import { Button } from "./components/ui/button";
import { buttonClassName } from "./components/ui/button-styles";
import { CheckboxField } from "./components/ui/checkbox-field";
import { EmptyState } from "./components/ui/empty-state";
import { Field } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { PanelHeader } from "./components/ui/panel-header";
import { ScrollArea } from "./components/ui/scroll-area";
import { SearchField } from "./components/ui/search-field";
import { rowClassName } from "./components/ui/row";
import { SettingsSectionHeader } from "./components/ui/settings-section-header";
import { SettingsGroup } from "./components/ui/settings-row";
import { Textarea } from "./components/ui/textarea";
import { MotionButton } from "./motion";
import { ResizableDrawer } from "./resizable-drawer";
import {
  type CloneTarget,
  type OverleafLink,
  type OverleafLoginPoll,
  type OverleafProject,
  type OverleafStatus,
} from "./app-types";
import { confirmAction, relativeTime, toMessage } from "./app-utils";
import { InlineMessage } from "./components/ui/inline-message";
import { notifyError, notifySuccess } from "./app-notify";
import { type OverleafRemoteDelete, type OverleafSyncMode } from "./app-settings";
import "./overleaf-connect.css";

/** Notification source label for everything in this file. */
const OVERLEAF_SOURCE = "Overleaf";

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
        <InfinityLoader size={15} />
        <span>Waiting for you to sign in in the Overleaf window…</span>
        <Button size="compact" variant="ghost" onClick={props.onCancel}>Cancel</Button>
      </div>
      {props.hint && <p className="overleaf-hint">{props.hint}</p>}
    </>
  );
}

/** Settings → Overleaf tab: connection status, sign-in, and the manual fallback. */
export function OverleafSettingsSection(props: {
  projectRoot: string | null;
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
  const [host, setHost] = useState(DEFAULT_OVERLEAF_HOST);
  const [cookie, setCookie] = useState("");
  const [applying, setApplying] = useState(false);
  const login = useOverleafLogin((session) => setStatus(session));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<OverleafStatus>("overleaf_status");
      setStatus(result);
      setLoadError(null);
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
    if (!props.projectRoot) {
      notifyError(OVERLEAF_SOURCE, "Open the linked Overleaf project before changing its sync setting.");
      return;
    }
    if (paused && !await confirmAction(
      "Pause syncing with Overleaf?\n\n"
      + "Nothing is sent or fetched until you resume, and live editing, chat and "
      + "collaborators stop. Every file stays where it is on both sides.\n\n"
      + "Resuming picks up where this left off: edits made on either side while it was "
      + "paused are merged, not overwritten.",
    )) return;
    try {
      await invoke("overleaf_set_paused", {
        projectRoot: props.projectRoot,
        paused,
      });
      setLink((current) => (current ? { ...current, paused } : current));
      props.onLinkChanged();
    } catch (reason) {
      notifyError(OVERLEAF_SOURCE, "Could not change Overleaf sync", { detail: toMessage(reason) });
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async () => {
    try {
      await invoke("overleaf_disconnect");
      await load();
      // Signing out ends the live channel too, so the rest of the app has to
      // re-read where it stands.
      props.onLinkChanged();
    } catch (reason) {
      notifyError(OVERLEAF_SOURCE, "Could not disconnect from Overleaf", { detail: toMessage(reason) });
    }
  };

  const applyCookie = async () => {
    if (!cookie.trim() || applying) return;
    setApplying(true);
    try {
      const result = await invoke<OverleafStatus>("overleaf_store_cookie", {
        host: host.trim() || DEFAULT_OVERLEAF_HOST,
        cookie: cookie.trim(),
      });
      setStatus(result);
      if (result.connected) {
        setCookie("");
        notifySuccess(OVERLEAF_SOURCE, `Connected to ${result.host}.`);
      } else {
        notifyError(OVERLEAF_SOURCE, "Overleaf didn’t accept that cookie. Make sure you’re signed in to Overleaf in your browser, then copy the Cookie header value again.");
      }
    } catch (reason) {
      notifyError(OVERLEAF_SOURCE, "Could not apply the Overleaf cookie", { detail: toMessage(reason) });
    }
    setApplying(false);
  };

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Overleaf"
        description="Connect your Overleaf account to open and sync your Overleaf projects directly in Lattice."
      />
      <SettingsGroup title="Connection">
        {loading && !loadError && (
        <EmptyState
          align="start"
          density="compact"
          icon={<InfinityLoader size={15} />}
          description="Checking your Overleaf connection…"
        />
        )}
        {loadError && (
        <>
          <InlineMessage level="error" className="overleaf-inline">{loadError}</InlineMessage>
          <div className="overleaf-retry-row">
            <ReloadButton
              size="compact"
              busy={loading}
              disabled={loading}
              onClick={() => void load()}
            >
              Try again
            </ReloadButton>
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
          <Button size="compact" onClick={() => void disconnect()}>Sign out</Button>
        </div>
        )}
        {!loading && !loadError && status && !status.connected && (
        login.pending ? (
          <LoginWaitingRow onCancel={login.cancel} hint={login.hint} />
        ) : (
          <div className="overleaf-connect-row">
            <MotionButton className={buttonClassName({ variant: "primary" })} onClick={login.begin}>
              <Cloud size={15} /> Connect to Overleaf
            </MotionButton>
            <p className="overleaf-hint">
              A secure Overleaf sign-in window will open. Lattice never sees your password — it only keeps the session Overleaf creates for you.
            </p>
          </div>
        )
        )}
        {login.error && <InlineMessage level="error" className="overleaf-inline">{login.error}</InlineMessage>}
        {login.notice && <InlineMessage level="info" className="overleaf-inline">{login.notice}</InlineMessage>}
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
          <Button
            size="compact"
            onClick={() => void setPaused(!link.paused)}
          >
            {link.paused ? "Resume syncing" : "Pause syncing"}
          </Button>
        </div>
        )}
      </SettingsGroup>
      <SettingsGroup title="Sync behavior">
        <fieldset className="overleaf-preference-group">
          <legend>Sync mode</legend>
          <div className="overleaf-mode">
            <label className="overleaf-mode-option ui-radio-choice">
              <input
                type="radio"
                name="overleaf-sync-mode"
                checked={props.syncMode === "live"}
                onChange={() => props.onSyncModeChange("live")}
              />
              <span className="ui-radio-dot" aria-hidden="true" />
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
                    {props.channel === "connecting"
                      && (props.channelDetail || "Connecting to Overleaf's editing channel…")}
                    {props.channel === "off" && "Open a linked project to start editing live."}
                    {props.channel === "error"
                      && `Live editing could not start${props.channelDetail ? `: ${props.channelDetail}` : ""}. Your project still syncs.`}
                  </small>
                )}
              </span>
            </label>
            <label className="overleaf-mode-option ui-radio-choice">
              <input
                type="radio"
                name="overleaf-sync-mode"
                checked={props.syncMode === "manual"}
                onChange={() => props.onSyncModeChange("manual")}
              />
              <span className="ui-radio-dot" aria-hidden="true" />
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
        </fieldset>
        <fieldset className="overleaf-preference-group">
          <legend>When you delete a file here</legend>
          <div className="overleaf-mode">
            {([
              {
                id: "ask" as const,
                title: "Ask before deleting",
                blurb: "A sync that finds a file missing here offers to remove it from Overleaf too.",
              },
              {
                id: "always" as const,
                title: "Delete on Overleaf too",
                blurb: "Keeps both sides identical. Overleaf's own history still has the file if it was a mistake.",
              },
              {
                id: "never" as const,
                title: "Keep it on Overleaf",
                blurb: "Nothing is ever removed from the shared project from here. The two sides stay different.",
              },
            ]).map((option) => (
              <label className="overleaf-mode-option ui-radio-choice" key={option.id}>
                <input
                  type="radio"
                  name="overleaf-remote-delete"
                  checked={props.remoteDelete === option.id}
                  onChange={() => props.onRemoteDeleteChange(option.id)}
                />
                <span className="ui-radio-dot" aria-hidden="true" />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.blurb}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </SettingsGroup>

      <SettingsGroup title="Advanced connection settings">
        <details className="overleaf-advanced">
        <summary>Advanced options</summary>
        <p className="overleaf-hint">
          Only needed if your lab runs its own Overleaf server (Community or Server Pro), or if the sign-in window doesn’t work.
        </p>
        <Field label="Server address" htmlFor="overleaf-server-address">
          <Input
            controlSize="form"
            id="overleaf-server-address"
            type="text"
            value={host}
            placeholder={DEFAULT_OVERLEAF_HOST}
            onChange={(event) => setHost(event.target.value)}
          />
        </Field>
        <Field label="Session cookie" htmlFor="overleaf-session-cookie">
          <Textarea
            font="mono"
            id="overleaf-session-cookie"
            value={cookie}
            placeholder="overleaf_session2=…"
            onChange={(event) => setCookie(event.target.value)}
          />
        </Field>
        <p className="overleaf-hint">
          Paste the Cookie header value from your browser’s DevTools if automatic sign-in doesn’t work.
        </p>
        <div className="overleaf-advanced-actions">
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            disabled={!cookie.trim() || applying}
            onClick={() => void applyCookie()}
          >
            {applying ? "Applying…" : "Apply"}
          </MotionButton>
        </div>
        </details>
      </SettingsGroup>
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
  /** Invalidate work scoped to the currently open project before root changes. */
  /** Claims the project switch; may wait out an in-flight sync, so await it. */
  onBeforeClone?: () => boolean | Promise<boolean>;
  /** Restore the old project identity when the root-changing request fails. */
  onCloneCancelled?: () => void;
  onCloned: (root: string) => void;
  onOpenSettings: () => void;
}) {
  const [status, setStatus] = useState<OverleafStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [projects, setProjects] = useState<OverleafProject[] | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [cloning, setCloning] = useState<OverleafProject | null>(null);
  const login = useOverleafLogin((session) => setStatus(session));
  const { onClose } = props;

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      setStatus(await invoke<OverleafStatus>("overleaf_status"));
      setStatusError(null);
    } catch (reason) {
      setStatusError(toMessage(reason));
    }
    setStatusLoading(false);
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjects(null);
    try {
      setProjects(await invoke<OverleafProject[]>("overleaf_list_projects"));
      setProjectsError(null);
    } catch (reason) {
      setProjectsError(toMessage(reason));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  // Fresh state on every open, then check the connection.
  useEffect(() => {
    if (!props.open) return;
    setSearch("");
    setShowArchived(false);
    setSelected(null);
    setCloning(null);
    setProjects(null);
    setProjectsLoading(false);
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
      if (await props.onBeforeClone?.() === false) {
        setCloning(null);
        return;
      }
      const root = await invoke<string>("overleaf_clone_project", {
        projectId: project.id,
        name: project.name,
        accessLevel: project.accessLevel,
        adopt,
      });
      setCloning(null);
      props.onCloned(root);
      onClose();
    } catch (reason) {
      setCloning(null);
      props.onCloneCancelled?.();
      // A project that is already downloaded now simply opens, so there is no
      // longer a "move the folder aside yourself" case to explain.
      notifyError(OVERLEAF_SOURCE, "Could not open the Overleaf project", { detail: toMessage(reason) });
    }
  };

  if (!props.open) return null;

  const query = search.trim().toLowerCase();
  const visible = (projects ?? [])
    .filter((project) => showArchived || (!project.archived && !project.trashed))
    .filter((project) => !query || [project.name, project.ownerName ?? "", project.ownerEmail ?? ""]
      .some((value) => value.toLowerCase().includes(query)));

  return (
    <ResizableDrawer
      className="overleaf-picker-drawer"
      dataTour="overleaf-panel"
      ariaLabel="Open from Overleaf"
      closeDisabled={Boolean(cloning)}
      onClose={onClose}
    >
      <PanelHeader
        className="drawer-header"
        icon={<Cloud size={16} />}
        title="Open from Overleaf"
        closeDisabled={Boolean(cloning)}
        closeTooltip={cloning ? "You can close this once the download finishes" : undefined}
        onClose={onClose}
      />
      <div className="modal overleaf-picker-modal overleaf-picker-drawer-content">
        {statusLoading && !statusError && (
          <div className="overleaf-loading">
            <InfinityLoader size={15} />
            <span>Checking your Overleaf connection…</span>
          </div>
        )}
        {statusError && (
          <>
            <InlineMessage level="error" className="overleaf-inline">{statusError}</InlineMessage>
            <div className="overleaf-retry-row">
              <ReloadButton
                size="compact"
                busy={statusLoading}
                disabled={statusLoading}
                onClick={() => void loadStatus()}
              >
                Retry
              </ReloadButton>
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
              <MotionButton className={buttonClassName({ variant: "primary" })} onClick={login.begin}>
                <Cloud size={15} /> Connect to Overleaf
              </MotionButton>
            )}
            {login.error && <InlineMessage level="error" className="overleaf-inline">{login.error}</InlineMessage>}
            {login.notice && <InlineMessage level="info" className="overleaf-inline">{login.notice}</InlineMessage>}
            <Button
              size="compact"
              variant="ghost"
              className="overleaf-advanced-link"
              onClick={() => { onClose(); props.onOpenSettings(); }}
            >
              Advanced options
            </Button>
          </>
        )}
        {!statusLoading && !statusError && status?.connected && (
          <>
            <p>Pick a project to download. Lattice keeps a local copy you can edit offline and sync back to Overleaf later.</p>
            <div className="overleaf-picker-controls">
              <SearchField
                aria-label="Search Overleaf projects"
                containerClassName="overleaf-search"
                placeholder="Search by project or owner…"
                autoFocus
                value={search}
                disabled={Boolean(cloning)}
                onChange={(event) => setSearch(event.target.value)}
                onClear={() => setSearch("")}
              />
              <CheckboxField
                className="overleaf-checkbox"
                checked={showArchived}
                disabled={Boolean(cloning)}
                label="Show archived"
                onChange={(event) => setShowArchived(event.target.checked)}
              />
            </div>
            {projectsError && (
              <>
                <InlineMessage level="error" className="overleaf-inline">{projectsError}</InlineMessage>
                <div className="overleaf-retry-row">
                  <ReloadButton
                    size="compact"
                    busy={projectsLoading}
                    disabled={projectsLoading}
                    onClick={() => void loadProjects()}
                  >
                    Retry
                  </ReloadButton>
                </div>
              </>
            )}
            {!projectsError && projects === null && (
              <div className="overleaf-loading">
                <InfinityLoader size={15} />
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
              <ScrollArea
                className="overleaf-project-list-scroll"
                orientation="vertical"
                viewportProps={{ "aria-label": "Overleaf projects" }}
              >
                <ul className="overleaf-project-list">
                  {visible.map((project) => (
                    <li
                      key={project.id}
                      className={rowClassName(
                        "store",
                        `overleaf-project-row${selected === project.id ? " selected" : ""}`,
                      )}
                    >
                      <button
                        type="button"
                        className="overleaf-project-main"
                        disabled={Boolean(cloning)}
                        onClick={() => setSelected(project.id)}
                      >
                        <span className="overleaf-project-name">
                          {project.name}
                          {project.trashed
                            ? <Badge size="compact">Trashed</Badge>
                            : project.archived
                              ? <Badge size="compact">Archived</Badge>
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
                          ? <InfinityLoader className="overleaf-row-spinner" size={15} />
                          : (
                            <MotionButton
                              className={buttonClassName({
                                variant: "primary",
                                size: "compact",
                                className: "overleaf-open-button",
                              })}
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
              </ScrollArea>
            )}
            {cloning && (
              <div className="overleaf-progress">
                <InfinityLoader size={15} />
                <span>Downloading {cloning.name} from Overleaf… this can take a minute for large projects.</span>
              </div>
            )}
            <p className="overleaf-footer-note">
              Changes sync when you press the sync button in the toolbar — Lattice keeps a local copy that works offline.
            </p>
          </>
        )}
      </div>
    </ResizableDrawer>
  );
}
