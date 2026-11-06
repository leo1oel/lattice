/**
 * Overleaf connection UI: the Settings → Overleaf section. The "Open from
 * Overleaf" project picker is `overleaf-project-picker.tsx`, and the pieces
 * both share are `overleaf-connect-parts.tsx`.
 *
 * Both talk to the Rust `overleaf` bridge over Tauri commands and are
 * written for novices: every state (disconnected, signing in, loading,
 * empty, error, downloading) says in plain language what is happening and
 * what to do next.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, CloudAlert, Link2 } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import type { OverleafLink, OverleafStatus } from "../app-types";
import { confirmAction, overleafLinkMatchesSession, relativeTime, toMessage } from "../app-utils";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import { notifyError, notifyInfo } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { onOverleafSessionChanged } from "./overleaf-realtime-listen";
import { useOverleafLogin } from "./use-overleaf-login";
import type { OverleafRemoteDelete, OverleafSyncMode } from "../settings/app-settings";
import "./overleaf-connect.css";
import { Glyph, LoginControls, LoginMessages, OVERLEAF_SOURCE, RetryRow } from "./overleaf-connect-parts";

/** A status tile, what it means, the detail beneath it, and an optional action. */
function StatusRow(props: { dot: "connected" | "paused"; icon: ReactNode; title: ReactNode; detail: ReactNode; children?: ReactNode }) {
  return (
    <div className="overleaf-status-row">
      <span className="overleaf-status-glyph">
        <Glyph tone="neutral">{props.icon}</Glyph>
        <span className={`overleaf-dot ${props.dot}`} aria-hidden="true" />
      </span>
      <div className="overleaf-status-text"><strong>{props.title}</strong><small>{props.detail}</small></div>
      {props.children}
    </div>
  );
}

/** A settings row whose control is a dropdown over `options`, in their listed order. */
function SelectRow<T extends string>({ label, description, value, onChange, options, setting }: {
  label: string; description?: ReactNode; value: T; onChange: (value: T) => void; options: Record<T, string>;
  /** What Settings search reveals this row by. */
  setting: string;
}) {
  return (
    <SettingsRow label={label} description={description} data-setting={setting}>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent data-settings-control="true" position="popper" align="end">
          {(Object.entries(options) as [T, string][]).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsRow>
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
      setStatus(await invoke<OverleafStatus>("overleaf_status"));
      setLoadError(null);
    } catch (reason) {
      setStatus(null);
      setLoadError(toMessage(reason));
    }
    // Whether the *open project* is tied to an Overleaf project is separate
    // from whether the account is connected, and only the former can be
    // stopped per project.
    setLink(await invoke<OverleafLink | null>("overleaf_link").catch(() => null));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  // The backend marks the session expired the moment Overleaf turns it away,
  // from whichever request noticed; this page must not keep saying signed in.
  useEffect(() => onOverleafSessionChanged(() => void load()), [load]);

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
    // Pausing takes effect at once, with Resume in the notice instead of a
    // confirmation in front of it: nothing is lost, and resuming merges.
    try {
      await invoke("overleaf_set_paused", { projectRoot: props.projectRoot, paused });
      setLink((current) => (current ? { ...current, paused } : current));
      props.onLinkChanged();
      if (paused) {
        notifyInfo(OVERLEAF_SOURCE, t`Overleaf sync paused`, {
          detail: t`Edits on both sides merge when you resume`,
          dedupeKey: "overleaf-sync-paused",
          primaryAction: { label: t`Resume`, onClick: () => setPaused(false) },
        });
      } else {
        dismissAppToastByDedupeKey("overleaf-sync-paused");
      }
    } catch (reason) {
      notifyError(OVERLEAF_SOURCE, t`Could not change Overleaf sync`, { detail: toMessage(reason) });
    }
  };

  const disconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      if (!await confirmAction({
        message: t`Sign out of Overleaf?

Linked projects stop syncing until you sign in again. Downloaded files stay on this Mac.`,
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

  /** The account's connection, once it has been read without error. */
  const known = !loading && !loadError ? status : null;
  const linkedHost = link?.host.trim() || status?.host.trim() || t`the linked Overleaf host`;
  // Kept out of the sentence below: a tagged template nested inside another is
  // not something the Lingui macro can extract.
  const fallbackAccountName = t`your Overleaf account`;
  const connectedToLinkedHost = Boolean(
    known?.connected && link && overleafLinkMatchesSession(known.host, link.host),
  );
  // Only the live channel's state is worth a line under Sync mode; "Live sync"
  // and "Manual" say the rest. Likewise only "Delete on Overleaf too" has a
  // fact its label can't carry: Overleaf's history still holds the file.
  const channelDescriptions = {
    connecting: t`Connecting live editing…`,
    error: t`Live editing is unavailable; regular syncing continues`,
    live: t`Live editing is connected`,
  };
  const deleteDescriptions = {
    always: t`Overleaf history keeps a copy`,
  };

  const linkDetail = (current: OverleafLink) => {
    if (loadError) return t`Couldn’t check the connection. Still linked to ${linkedHost}`;
    if (loading || !status) return t`Checking the connection to ${linkedHost}…`;
    if (!status.connected) {
      return current.paused
        ? t`Sign in to ${linkedHost}, then resume`
        : t`Sign in to ${linkedHost} to resume syncing`;
    }
    if (!connectedToLinkedHost) return t`This project uses ${linkedHost}. Sign out and connect to it to resume`;
    return current.lastSync ? t`Last synced ${relativeTime(current.lastSync)}` : t`Not synced yet`;
  };

  return (
    <div className="settings-section">
      {/* eslint-disable-next-line lattice/visible-attribute-text -- product name */}
      <SettingsSectionHeader title="Overleaf" />
      <SettingsGroup title={t`Connection`} data-setting="overleaf-connection">
        {loading && !loadError && (
          <>
            {/* One small status; its words go to assistive technology, not beside it. */}
            <EmptyState align="start" density="compact" icon={<InfinityLoader size={15} />} />
            <LoadingAnnouncement message={t`Checking your Overleaf connection…`} />
          </>
        )}
        {loadError && <RetryRow error={loadError} busy={loading} label={t`Try again`} onRetry={() => void load()} />}
        {known?.connected && (
          <StatusRow dot="connected" icon={<Cloud size={15} />} title={t`Connected as ${known.email ?? known.name ?? fallbackAccountName}`} detail={known.host}>
            <Button size="compact" disabled={disconnecting} onClick={() => void disconnect()}>
              {disconnecting && <InfinityLoader size={12} />}
              {t`Sign out`}
            </Button>
          </StatusRow>
        )}
        {known?.expired && (
          <StatusRow dot="paused" icon={<CloudAlert size={15} />} title={t`Your Overleaf session expired. Sign in again`} detail={known.email ?? known.name ?? known.host}>
            <Button size="compact" disabled={disconnecting} onClick={() => void disconnect()}>
              {disconnecting && <InfinityLoader size={12} />}
              {t`Sign out`}
            </Button>
          </StatusRow>
        )}
        {known && !known.connected ? (
          <div className="overleaf-connect-card">
            <div className="overleaf-connect-card-body">
              <LoginControls
                login={login}
                label={known.expired ? t`Reconnect to Overleaf` : t`Connect to Overleaf`}
                hint={t`You sign in on Overleaf. Lattice never sees your password.`}
              />
            </div>
          </div>
        ) : <LoginMessages login={login} />}
        {link && (
          <StatusRow
            dot={!connectedToLinkedHost || link.paused ? "paused" : "connected"}
            icon={<Link2 size={15} />}
            title={!connectedToLinkedHost
              ? t`“${link.projectName}” stays linked`
              : link.paused
                ? t`Syncing with “${link.projectName}” is paused`
                : t`This project syncs with “${link.projectName}”`}
            detail={linkDetail(link)}
          >
            {connectedToLinkedHost && (
              <Button size="compact" onClick={() => void setPaused(!link.paused)}>
                {link.paused ? t`Resume syncing` : t`Pause syncing`}
              </Button>
            )}
          </StatusRow>
        )}
      </SettingsGroup>
      <SettingsGroup title={t`Sync behavior`}>
        <SelectRow
          setting="overleaf-sync-mode"
          label={t`Sync mode`}
          description={props.syncMode === "live" && props.channel !== "off" ? (
            <span className={`overleaf-channel overleaf-channel-${props.channel}`} title={props.channelDetail ?? undefined}>
              {channelDescriptions[props.channel]}
            </span>
          ) : undefined}
          value={props.syncMode}
          onChange={props.onSyncModeChange}
          options={{ live: t`Live sync`, manual: t`Manual` }}
        />
        <SelectRow
          setting="overleaf-remote-delete"
          label={t`When you delete a file here`}
          description={props.remoteDelete === "always" ? deleteDescriptions.always : undefined}
          value={props.remoteDelete}
          onChange={props.onRemoteDeleteChange}
          options={{ ask: t`Ask before deleting`, always: t`Delete on Overleaf too`, never: t`Keep it on Overleaf` }}
        />
      </SettingsGroup>
    </div>
  );
}
