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
import { useLingui } from "@lingui/react/macro";
import { Badge } from "../components/ui/badge";
import { InfinityLoader, ReloadButton } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { CheckboxField } from "../components/ui/checkbox-field";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { PanelHeader } from "../components/ui/panel-header";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import { rowClassName } from "../components/ui/row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { MotionButton } from "../components/ui/motion";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import {
  type CloneTarget,
  type OverleafLink,
  type OverleafLoginPoll,
  type OverleafProject,
  type OverleafStatus,
} from "../app-types";
import { confirmAction, overleafLinkMatchesSession, relativeTime, toMessage } from "../app-utils";
import { InlineMessage } from "../components/ui/inline-message";
import { notifyError, notifySuccess } from "../telemetry/app-notify";
import { type OverleafRemoteDelete, type OverleafSyncMode } from "../settings/app-settings";
import "./overleaf-connect.css";

/** Notification source label for everything in this file. */
const OVERLEAF_SOURCE = "Overleaf";

function isOverleafSessionExpired(reason: unknown): boolean {
  return /overleaf session expired/i.test(toMessage(reason));
}

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
  const { t } = useLingui();
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

  const poll = useCallback(async function pollForLogin() {
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
        setNotice(t`Sign-in was cancelled. You can try again whenever you’re ready.`);
        return;
      }
      // Signing in takes a few seconds, but it should never take half a minute.
      // Rather than spin forever, say what to do next (and why, when the
      // backend got far enough to have a reason).
      attempts.current += 1;
      if (attempts.current >= 20) {
        setHint(
          result.detail
            ? t`Still not connected: ${result.detail}`
            : t`Still waiting. Cancel this attempt, close the Overleaf window, and try connecting again`,
        );
      }
      timer.current = setTimeout(() => void pollForLogin(), 1500);
    } catch (reason) {
      if (!active.current) return;
      stop();
      setError(toMessage(reason));
    }
  }, [stop, t]);

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
    setNotice(t`Sign-in was cancelled. You can try again whenever you’re ready.`);
  }, [stop, t]);

  return { pending, error, notice, hint, begin, cancel };
}

function LoginWaitingRow(props: { onCancel: () => void; hint?: string | null }) {
  const { t } = useLingui();
  return (
    <>
      <div className="overleaf-waiting">
        <InfinityLoader size={15} />
        <span>{t`Waiting for you to sign in in the Overleaf window…`}</span>
        <Button size="compact" variant="ghost" onClick={props.onCancel}>{t`Cancel`}</Button>
      </div>
      {props.hint && <p className="overleaf-hint">{props.hint}</p>}
    </>
  );
}

/** Settings → Overleaf tab: connection status and sync behavior. */
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
  const { t } = useLingui();
  const [status, setStatus] = useState<OverleafStatus | null>(null);
  const [link, setLink] = useState<OverleafLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const login = useOverleafLogin((session) => {
    setStatus(session);
    if (session.connected) props.onLinkChanged();
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<OverleafStatus>("overleaf_status");
      setStatus(result);
      setLoadError(null);
    } catch (reason) {
      setStatus(null);
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
      notifyError(OVERLEAF_SOURCE, t`Open the linked Overleaf project before changing its sync setting.`);
      return;
    }
    if (paused && !await confirmAction(
      t`Pause syncing with Overleaf?

Nothing is sent or fetched until you resume, and live editing, chat and collaborators stop. Every file stays where it is on both sides.

Resuming picks up where this left off: edits made on either side while it was paused are merged, not overwritten.`,
    )) return;
    try {
      await invoke("overleaf_set_paused", {
        projectRoot: props.projectRoot,
        paused,
      });
      setLink((current) => (current ? { ...current, paused } : current));
      props.onLinkChanged();
    } catch (reason) {
      notifyError(OVERLEAF_SOURCE, t`Could not change Overleaf sync`, { detail: toMessage(reason) });
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      if (!await confirmAction({
        message: t`Sign out of Overleaf?

Lattice will no longer be able to list your Overleaf projects, sync linked projects, or use live editing until you sign in again. Files already downloaded to this Mac will not be deleted.`,
        confirmLabel: t`Sign out`,
        destructive: false,
      })) return;
      await invoke("overleaf_disconnect");
      await load();
      // Signing out ends the live channel too, so the rest of the app has to
      // re-read where it stands.
      props.onLinkChanged();
    } catch (reason) {
      notifyError(OVERLEAF_SOURCE, t`Could not disconnect from Overleaf`, { detail: toMessage(reason) });
    } finally {
      setDisconnecting(false);
    }
  };

  const connectionKnown = !loading && !loadError && Boolean(status);
  const linkedHost = link?.host.trim() || status?.host.trim() || t`the linked Overleaf host`;
  // Kept out of the sentence below: a tagged template nested inside another is
  // not something the Lingui macro can extract.
  const fallbackAccountName = t`your Overleaf account`;
  const connectedToLinkedHost = Boolean(
    connectionKnown && status?.connected && link && overleafLinkMatchesSession(status.host, link.host),
  );
  const syncModeDescription = props.syncMode === "manual"
    ? t`Sync only when you click the sync button`
    : props.channel === "connecting"
      ? t`Connecting live editing…`
      : props.channel === "error"
        ? t`Live editing is unavailable; regular syncing continues`
        : props.channel === "live"
          ? t`Live editing is connected`
          : t`Edits sync live with Overleaf`;

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Overleaf"
        description={t`Open and sync Overleaf projects in Lattice`}
      />
      <SettingsGroup title={t`Connection`}>
        {loading && !loadError && (
        <EmptyState
          align="start"
          density="compact"
          icon={<InfinityLoader size={15} />}
          description={t`Checking your Overleaf connection…`}
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
              {t`Try again`}
            </ReloadButton>
          </div>
        </>
        )}
        {!loading && !loadError && status?.connected && (
        <div className="overleaf-status-row">
          <span className="overleaf-dot connected" aria-hidden="true" />
          <div className="overleaf-status-text">
            <strong>{t`Connected as ${status.email ?? status.name ?? fallbackAccountName}`}</strong>
            <small>{status.host}</small>
          </div>
          <Button size="compact" disabled={disconnecting} onClick={() => void disconnect()}>
            {disconnecting && <InfinityLoader size={12} />}
            {t`Sign out`}
          </Button>
        </div>
        )}
        {!loading && !loadError && status && !status.connected && (
        login.pending ? (
          <LoginWaitingRow onCancel={login.cancel} hint={login.hint} />
        ) : (
          <div className="overleaf-connect-row">
            <MotionButton className={buttonClassName({ variant: "primary" })} onClick={login.begin}>
              <Cloud size={15} /> {t`Connect to Overleaf`}
            </MotionButton>
            <p className="overleaf-hint">
              {t`A secure Overleaf sign-in window will open. Lattice never sees your password — it only keeps the session Overleaf creates for you`}
            </p>
          </div>
        )
        )}
        {login.error && <InlineMessage level="error" className="overleaf-inline">{login.error}</InlineMessage>}
        {login.notice && <InlineMessage level="info" className="overleaf-inline">{login.notice}</InlineMessage>}
        {link && (
        <div className="overleaf-status-row">
          <span className={`overleaf-dot ${!connectedToLinkedHost || link.paused ? "paused" : "connected"}`} aria-hidden="true" />
          <div className="overleaf-status-text">
            <strong>
              {!connectedToLinkedHost
                ? t`“${link.projectName}” stays linked`
                : link.paused
                ? t`Syncing with “${link.projectName}” is paused`
                : t`This project syncs with “${link.projectName}”`}
            </strong>
            <small>
              {loadError
                ? t`Connection status is unavailable. This project remains linked to ${linkedHost}; try checking the connection again above`
                : loading || !status
                  ? t`Checking the connection to ${linkedHost}…`
                : !status.connected
                ? link.paused
                  ? t`Sign in to ${linkedHost}, then resume syncing when you are ready. Local files stay on this Mac`
                  : t`Sign in to resume syncing and live editing on ${linkedHost}. Local files stay on this Mac`
                : !connectedToLinkedHost
                  ? t`This project uses ${linkedHost}. Sign out above, then connect to that host to resume. Local files stay on this Mac`
                : link.paused
                ? t`Nothing is sent or fetched until you resume`
                : link.lastSync ? t`Last synced ${relativeTime(link.lastSync)}` : t`Not synced yet`}
            </small>
          </div>
          {connectedToLinkedHost && <Button
            size="compact"
            onClick={() => void setPaused(!link.paused)}
          >
            {link.paused ? t`Resume syncing` : t`Pause syncing`}
          </Button>}
        </div>
        )}
      </SettingsGroup>
      <SettingsGroup title={t`Sync behavior`}>
        <SettingsRow
          label={t`Sync mode`}
          description={props.syncMode === "live" && props.channel !== "off" ? (
            <span
              className={`overleaf-channel overleaf-channel-${props.channel}`}
              title={props.channelDetail ?? undefined}
            >
              {syncModeDescription}
            </span>
          ) : syncModeDescription}
        >
          <Select
            value={props.syncMode}
            onValueChange={(value) => props.onSyncModeChange(value as OverleafSyncMode)}
          >
            <SelectTrigger size="form" aria-label={t`Sync mode`}><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="end">
              <SelectItem value="live">{t`Live sync`}</SelectItem>
              <SelectItem value="manual">{t`Manual`}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label={t`When you delete a file here`}
          description={props.remoteDelete === "ask"
            ? t`A sync that finds a file missing here offers to remove it from Overleaf too`
            : props.remoteDelete === "always"
              ? t`Keeps both sides identical. Overleaf's own history still has the file if it was a mistake`
              : t`Nothing is ever removed from the shared project from here. The two sides stay different`}
        >
          <Select
            value={props.remoteDelete}
            onValueChange={(value) => props.onRemoteDeleteChange(value as OverleafRemoteDelete)}
          >
            <SelectTrigger size="form" aria-label={t`When you delete a file here`}><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="end">
              <SelectItem value="ask">{t`Ask before deleting`}</SelectItem>
              <SelectItem value="always">{t`Delete on Overleaf too`}</SelectItem>
              <SelectItem value="never">{t`Keep it on Overleaf`}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
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
  /** The open, unlinked local project that can become a new Overleaf project. */
  currentProject?: { name: string } | null;
  /** Saves, uploads and links the current project. False means saving was cancelled. */
  onPublish?: (name: string) => Promise<boolean>;
  /** Re-read account-dependent project state after sign-out or sign-in. */
  onConnectionChanged?: () => void;
}) {
  const { t } = useLingui();
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
  const [publishing, setPublishing] = useState(false);
  const [publishName, setPublishName] = useState(props.currentProject?.name ?? "");
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const login = useOverleafLogin((session) => {
    setReconnectRequired(false);
    setStatus(session);
    props.onConnectionChanged?.();
  });
  const { onClose } = props;

  const requireReconnect = useCallback(async () => {
    // Once Overleaf has rejected this session it is no longer a connection.
    // Remove the dead credential so Settings and background sync agree with
    // the reconnect state this panel now shows; project links stay on disk.
    await invoke("overleaf_disconnect").catch(() => {});
    setProjects(null);
    setProjectsError(null);
    setStatusError(null);
    setReconnectRequired(true);
    setStatus((current) => ({
      connected: false,
      email: null,
      name: null,
      host: current?.host ?? "https://www.overleaf.com",
    }));
    props.onConnectionChanged?.();
  }, [props.onConnectionChanged]);

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
      if (isOverleafSessionExpired(reason)) {
        await requireReconnect();
      } else {
        setProjectsError(toMessage(reason));
      }
    } finally {
      setProjectsLoading(false);
    }
  }, [requireReconnect]);

  // Fresh state on every open, then check the connection.
  useEffect(() => {
    if (!props.open) return;
    setSearch("");
    setShowArchived(false);
    setSelected(null);
    setCloning(null);
    setPublishing(false);
    setPublishName(props.currentProject?.name ?? "");
    setReconnectRequired(false);
    setProjects(null);
    setProjectsLoading(false);
    setProjectsError(null);
    void loadStatus();
  }, [props.open, props.currentProject?.name, loadStatus]);

  // Once connected (on open, or right after the in-dialog login), list projects.
  useEffect(() => {
    if (props.open && status?.connected) void loadProjects();
  }, [props.open, status?.connected, loadProjects]);

  const publish = async () => {
    const name = publishName.trim();
    if (!name || !props.currentProject || !props.onPublish || publishing || cloning) return;
    if (!await confirmAction(
      t`Upload “${name}” to Overleaf and connect this folder?

Lattice will create a new Overleaf project from the files that normally sync. Lattice app data, saved account credentials, build output and Git history stay on this Mac.`,
    )) return;
    setPublishing(true);
    try {
      if (await props.onPublish(name)) {
        notifySuccess(OVERLEAF_SOURCE, t`Project uploaded and connected to Overleaf.`);
        onClose();
      }
    } catch (reason) {
      if (isOverleafSessionExpired(reason)) {
        await requireReconnect();
      } else {
        notifyError(OVERLEAF_SOURCE, t`Could not upload the project to Overleaf`, { detail: toMessage(reason) });
      }
    } finally {
      setPublishing(false);
    }
  };

  const clone = async (project: OverleafProject) => {
    if (cloning || publishing) return;
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
          t`“${target.folder}” already has files in it and isn’t linked to Overleaf.

OK — link that folder to this Overleaf project. Files that differ are kept both ways: Overleaf’s version takes the filename and yours is saved beside it as “name (local conflict …)”. Nothing is overwritten or thrown away.

Cancel — download a separate copy into a new folder and leave that one alone.`,
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
      if (isOverleafSessionExpired(reason)) {
        await requireReconnect();
      } else {
        notifyError(OVERLEAF_SOURCE, t`Could not open the Overleaf project`, { detail: toMessage(reason) });
      }
    }
  };

  if (!props.open) return null;

  const query = search.trim().toLowerCase();
  const visible = (projects ?? [])
    .filter((project) => showArchived || (!project.archived && !project.trashed))
    .filter((project) => !query || [project.name, project.ownerName ?? "", project.ownerEmail ?? ""]
      .some((value) => value.toLowerCase().includes(query)));
  const working = Boolean(cloning) || publishing;

  return (
    <ResizableDrawer
      className="overleaf-picker-drawer"
      dataTour="overleaf-panel"
      ariaLabel={t`Open from Overleaf`}
      closeDisabled={working}
      onClose={onClose}
    >
      <PanelHeader
        className="drawer-header"
        icon={<Cloud size={16} />}
        title={t`Open from Overleaf`}
        closeDisabled={working}
        closeTooltip={working ? t`You can close this once the transfer finishes` : undefined}
        onClose={onClose}
      />
      <div className="modal overleaf-picker-modal overleaf-picker-drawer-content">
        {statusLoading && !statusError && (
          <div className="overleaf-loading">
            <InfinityLoader size={15} />
            <span>{t`Checking your Overleaf connection…`}</span>
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
                {t`Retry`}
              </ReloadButton>
            </div>
          </>
        )}
        {!statusLoading && !statusError && status && !status.connected && (
          <>
            {reconnectRequired ? (
              <InlineMessage level="warning" className="overleaf-inline">
                {t`Your Overleaf session has expired. Sign in again to continue. Your local files and existing project links are unchanged`}
              </InlineMessage>
            ) : (
              <p>
                {t`Your Overleaf account isn’t connected yet. Connect it once, and every project from your Overleaf account will show up here, ready to open in Lattice`}
              </p>
            )}
            {login.pending ? (
              <LoginWaitingRow onCancel={login.cancel} hint={login.hint} />
            ) : (
              <MotionButton className={buttonClassName({ variant: "primary" })} onClick={login.begin}>
                <Cloud size={15} /> {reconnectRequired ? t`Reconnect to Overleaf` : t`Connect to Overleaf`}
              </MotionButton>
            )}
            {login.error && <InlineMessage level="error" className="overleaf-inline">{login.error}</InlineMessage>}
            {login.notice && <InlineMessage level="info" className="overleaf-inline">{login.notice}</InlineMessage>}
          </>
        )}
        {!statusLoading && !statusError && status?.connected && (
          <>
            {props.currentProject && props.onPublish && (
              <section className="overleaf-publish-card">
                <div className="overleaf-publish-copy">
                  <strong>{t`Upload this project to Overleaf`}</strong>
                  <span>{t`Create a new Overleaf project and keep this folder connected to it`}</span>
                </div>
                <div className="overleaf-publish-actions">
                  <Input
                    controlSize="form"
                    aria-label={t`New Overleaf project name`}
                    value={publishName}
                    disabled={working}
                    onChange={(event) => setPublishName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void publish();
                    }}
                  />
                  <MotionButton
                    className={buttonClassName({ variant: "primary", size: "form" })}
                    disabled={working || !publishName.trim()}
                    onClick={() => void publish()}
                  >
                    {publishing ? <InfinityLoader size={13} /> : <Cloud size={14} />}
                    {publishing ? t`Uploading…` : t`Upload and connect`}
                  </MotionButton>
                </div>
              </section>
            )}
            <div className="overleaf-picker-controls">
              <SearchField
                aria-label={t`Search Overleaf projects`}
                containerClassName="overleaf-search"
                placeholder={t`Search by project or owner…`}
                autoFocus
                value={search}
                disabled={working}
                onChange={(event) => setSearch(event.target.value)}
                onClear={() => setSearch("")}
              />
              <CheckboxField
                className="overleaf-checkbox"
                checked={showArchived}
                disabled={working}
                label={t`Show archived`}
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
                    {t`Retry`}
                  </ReloadButton>
                </div>
              </>
            )}
            {!projectsError && projects === null && (
              <div className="overleaf-loading">
                <InfinityLoader size={15} />
                <span>{t`Loading your Overleaf projects…`}</span>
              </div>
            )}
            {!projectsError && projects !== null && visible.length === 0 && (
              <p className="overleaf-empty">
                {projects.length === 0
                  ? t`No projects in this account yet. Create one on Overleaf and it will appear here`
                  : query
                    ? t`No projects match your search`
                    : t`All of your projects are archived or trashed. Tick “Show archived” to see them`}
              </p>
            )}
            {!projectsError && projects !== null && visible.length > 0 && (
              <ScrollArea
                className="overleaf-project-list-scroll"
                orientation="vertical"
                viewportProps={{ "aria-label": t`Overleaf projects` }}
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
                        disabled={working}
                        onClick={() => setSelected(project.id)}
                      >
                        <span className="overleaf-project-name">
                          {project.name}
                          {project.trashed
                            ? <Badge size="compact">{t`Trashed`}</Badge>
                            : project.archived
                              ? <Badge size="compact">{t`Archived`}</Badge>
                              : null}
                        </span>
                        <span className="overleaf-project-meta">
                          {project.ownerName || project.ownerEmail || t`Unknown owner`}
                          {" · "}
                          {project.lastUpdated ? t`updated ${relativeTime(project.lastUpdated)}` : t`last update unknown`}
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
                              disabled={working}
                              onClick={() => void clone(project)}
                            >
                              {t`Open`}
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
                <span>{t`Downloading ${cloning.name} from Overleaf… this can take a minute for large projects`}</span>
              </div>
            )}
            {publishing && (
              <div className="overleaf-progress">
                <InfinityLoader size={15} />
                <span>{t`Uploading ${publishName.trim()} to Overleaf… this can take a minute for large projects`}</span>
              </div>
            )}
          </>
        )}
      </div>
    </ResizableDrawer>
  );
}
