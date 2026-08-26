import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, Copy, Radio, X } from "lucide-react";
import { IconSwap, MotionButton } from "../components/ui/motion";
import { confirmAction } from "../app-utils";
import { isLocalCollabHost } from "./collab-config";
import type { CollabChatMessage, CollabPeer, CollabStatus } from "./collab-session";
import type { CollabProjectRecordV2 } from "./collab-rooms";
import { CollabChatPanel } from "./collab-chat";
import { Button } from "../components/ui/button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { buttonClassName } from "../components/ui/button-styles";
import { IconButton } from "../components/ui/icon-button";
import { Input } from "../components/ui/input";
import { PanelHeader } from "../components/ui/panel-header";
import { rowClassName } from "../components/ui/row";
import { ScrollArea } from "../components/ui/scroll-area";
import { SegmentedControl } from "../components/ui/segmented-control";
import { Textarea } from "../components/ui/textarea";
import { ResizableDrawer } from "../components/ui/resizable-drawer";

export type CollabDialogMode = "start" | "join";
/** Which half of the live card is showing. Chat only exists once a room is live. */
type CollabLiveTab = "status" | "chat";

function roomRelativeTime(timestamp: number, locale: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (elapsed < 60_000) return formatter.format(0, "second");
  if (elapsed < 3_600_000) return formatter.format(-Math.floor(elapsed / 60_000), "minute");
  if (elapsed < 86_400_000) return formatter.format(-Math.floor(elapsed / 3_600_000), "hour");
  if (elapsed < 30 * 86_400_000) return formatter.format(-Math.floor(elapsed / 86_400_000), "day");
  if (elapsed < 365 * 86_400_000) return formatter.format(-Math.floor(elapsed / (30 * 86_400_000)), "month");
  return formatter.format(-Math.floor(elapsed / (365 * 86_400_000)), "year");
}

export function CollabDialog(props: {
  open: boolean;
  mode: CollabDialogMode;
  role: "host" | "guest";
  host: string;
  room: string;
  displayName: string;
  projectName: string;
  inviteText: string;
  status: CollabStatus;
  statusDetail: string | null;
  peerCount: number;
  peers?: CollabPeer[];
  fileCount: number;
  connectedRoom: string | null;

  /** When true, Start sharing is hidden (e.g. welcome screen Join-only). */
  joinOnly?: boolean;
  onClose: () => void;
  onModeChange: (mode: CollabDialogMode) => void;
  onRoomChange: (room: string) => void;
  onDisplayNameChange: (name: string) => void;
  onProjectNameChange: (name: string) => void;
  onInviteChange: (invite: string) => void;
  onStartShare: () => void;
  onJoinShare: () => void;
  recentProjectsV2?: CollabProjectRecordV2[];
  onRejoinProjectV2?: (record: CollabProjectRecordV2) => void;
  onForgetProjectV2?: (record: CollabProjectRecordV2) => void;
  /** Receives the trimmed name; the dialog owns the rename field (Tauri has no window.prompt). */
  onRenameProjectV2?: (record: CollabProjectRecordV2, name: string) => void;
  onCloseProjectV2?: (record: CollabProjectRecordV2) => void;
  /** Ends the session: for a guest, leaves; for a host, closes the room for everyone. */
  onDisconnect: () => void;
  /** Host-only: disconnect yourself but leave the room running for the others. */
  onLeaveShare?: () => void;
  /** Resolves `false` when the copy failed and was already surfaced. */
  onCopyInvite: () => Promise<boolean | void> | boolean | void;
  onRemovePeer?: (peer: CollabPeer) => Promise<void> | void;
  onInstallTex?: () => void;

  /** Omitting these leaves the live card exactly as it was — chat is opt-in per caller. */
  chatMessages?: CollabChatMessage[];
  chatSelfId?: string;
  chatUnread?: number;
  onChatSend?: (body: string) => void;
  /** Fires whenever the chat tab is the visible one while the dialog is open, to clear the badge. */
  onChatOpen?: () => void;
}) {
  const { i18n, t } = useLingui();
  const [copied, setCopied] = useState(false);
  const [removingPeer, setRemovingPeer] = useState<string | null>(null);
  const [liveTab, setLiveTab] = useState<CollabLiveTab>("status");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const sendChat = props.onChatSend;
  const chatEnabled = Boolean(sendChat);
  // Destructured so the effect below depends on the specific values it reads
  // rather than the whole `props` object, which is a fresh reference every
  // render and would make the dependency meaningless.
  const { open, chatMessages, onChatOpen } = props;

  // Reading the tab counts as reading the chat: clear the badge the moment it
  // is what's on screen, and keep clearing it as more arrives while it stays
  // the visible tab (mirrors the equivalent effect for Overleaf's chat drawer).
  useEffect(() => {
    if (open && chatEnabled && liveTab === "chat") onChatOpen?.();
  }, [open, chatEnabled, liveTab, chatMessages, onChatOpen]);

  if (!props.open) return null;

  // A session exists as long as we have a connected room. Keep showing the live
  // card (with Leave/Stop) through a transient error/reconnect instead of
  // dropping back to the Start/Join form and losing the disconnect button.
  const live = props.connectedRoom != null || props.status === "synced";
  const starting = props.status === "connecting" && props.connectedRoom == null;
  const localHost = isLocalCollabHost(props.host);
  const nameReady = props.displayName.trim().length > 0;
  const roomNameReady = props.projectName.trim().length > 0;
  const mode = props.joinOnly ? "join" : props.mode;
  // Rooms you host and rooms you joined are different things to do, and the
  // tab you are on says which one you mean: Start sharing lists the rooms you
  // can reopen and end, Join lists the ones you can go back into. One combined
  // list under Start sharing offered to "start" a room you are only a guest in.
  const recentRooms = (props.recentProjectsV2 ?? [])
    .filter((record) => (
      mode === "start" ? record.permission === "host" : record.permission !== "host"
    ))
    .sort((left, right) => (
      (right.createdAt ?? right.lastUsed) - (left.createdAt ?? left.lastUsed)
    ));
  const recentRoomsTitle = mode === "start" ? t`Rooms you host` : t`Rooms you joined`;
  const othersLabel = props.peerCount === 0
    ? t`just you`
    : props.peerCount === 1
      ? t`1 other`
      : t`${props.peerCount} others`;
  const roleLabel = props.role === "guest" ? t`Joined` : t`Sharing`;
  const fileCountLabel = props.fileCount === 1 ? t`1 file` : t`${props.fileCount} files`;
  const connectedRoomLabel = props.connectedRoom ?? "";

  const copyInvite = async () => {
    // `false` means the copy failed (and was surfaced by the handler) — the
    // button must not flip to "Copied".
    if ((await props.onCopyInvite()) === false) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  /**
   * Disconnect yourself. For a guest that is the only exit; for the host the
   * room stays live for everyone else, so it needs no confirmation — nothing
   * is destroyed and Your shared rooms can take them back in.
   */
  const leaveShare = () => {
    if (props.role === "host" && props.onLeaveShare) {
      props.onLeaveShare();
      return;
    }
    props.onDisconnect();
  };

  const stopSharing = async () => {
    const ok = await confirmAction(
      t({
        message: "Stop sharing for everyone?\n\nCollaborators will be disconnected and returned to their previous projects. This cannot be undone — reopening the room means sending a new invite.",
      }),
    );
    if (!ok) return;
    props.onDisconnect();
  };

  const removePeer = async (peer: CollabPeer) => {
    if (!peer.grantId || !props.onRemovePeer) return;
    const removeConfirmation = t({
      message: `Remove ${peer.name}?\n\nThey will lose access immediately. Anyone who joined with the same invite will also lose access.`,
    });
    if (!await confirmAction(removeConfirmation)) return;
    setRemovingPeer(peer.grantId);
    try {
      await props.onRemovePeer(peer);
    } finally {
      setRemovingPeer(null);
    }
  };

  const beginRename = (record: CollabProjectRecordV2) => {
    setRenamingId(record.projectInstanceId);
    setRenameDraft(record.title);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };

  const commitRename = (record: CollabProjectRecordV2) => {
    const name = renameDraft.trim();
    if (!name || name === record.title) {
      cancelRename();
      return;
    }
    props.onRenameProjectV2?.(record, name);
    cancelRename();
  };

  return (
    <ResizableDrawer
      className="collab-drawer"
      dataTour="collaboration-panel"
      ariaLabel={t`Live collaboration`}
      onClose={props.onClose}
    >
      <PanelHeader
        className="drawer-header"
        icon={<Radio size={16} />}
        title={t`Live collaboration`}
        onClose={props.onClose}
      />
      <div className="modal collab-modal collab-drawer-content">
        {!live && !props.joinOnly ? (
          <SegmentedControl
            value={mode}
            onChange={props.onModeChange}
            ariaLabel={t`Share mode`}
            size="default"
            tone="accent"
            className="collab-mode-switch"
            items={[
              { value: "start", label: t`Start sharing` },
              { value: "join", label: t`Join` },
            ]}
          />
        ) : null}

        <div className="collab-field">
          <label>
            {t`Your name`}
            <Input
              controlSize="form"
              aria-label={t`Collab display name`}
              placeholder={t`Ada`}
              value={props.displayName}
              disabled={live}
              onChange={(event) => props.onDisplayNameChange(event.target.value)}
            />
          </label>
          {!live && !nameReady ? (
            <p className="collab-help collab-name-help">{t`Enter your name so others can see who is editing`}</p>
          ) : null}
        </div>

        {!live && mode === "start" && !props.joinOnly ? (
          <label>
            {t`Room name`}
            <Input
              controlSize="form"
              aria-label={t`Collab room name`}
              placeholder={t`Attention paper`}
              value={props.projectName}
              maxLength={80}
              onChange={(event) => props.onProjectNameChange(event.target.value)}
            />
          </label>
        ) : null}

        {!live && recentRooms.length > 0 ? (
          <div className="collab-recent">
            <div className="collab-recent-title">{recentRoomsTitle}</div>
            <ScrollArea
              className="collab-recent-scroll"
              orientation="both"
              fadeEdges={false}
              contentClassName="collab-recent-scroll-content"
              viewportProps={{
                "aria-label": recentRoomsTitle,
                // Cap height on the viewport: ScrollArea defaults to height:100%,
                // which ignores a max-height-only parent. Width is clamped on the
                // root so sideways overflow scrolls inside Lattice, not the drawer.
                style: { height: "auto", maxHeight: 168 },
              }}
            >
              <ul className="collab-recent-list">
                {recentRooms.map((record) => {
                  const renaming = renamingId === record.projectInstanceId;
                  const createdAt = record.createdAt ?? record.lastUsed;
                  return (
                    <li key={`v2:${record.host}:${record.projectInstanceId}`} className="collab-recent-row">
                      {renaming ? (
                        <form
                          className="collab-recent-rename"
                          onSubmit={(event) => {
                            event.preventDefault();
                            commitRename(record);
                          }}
                        >
                          <Input
                            controlSize="compact"
                            aria-label={t`Rename ${record.title}`}
                            value={renameDraft}
                            maxLength={80}
                            autoFocus
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                          />
                          <Button size="compact" type="submit">{t`Save`}</Button>
                          <Button size="compact" variant="ghost" type="button" onClick={cancelRename}>{t`Cancel`}</Button>
                        </form>
                      ) : (
                        <>
                          <button type="button" className={rowClassName("data", "collab-recent-item")} onClick={() => props.onRejoinProjectV2?.(record)} title={t`Rejoin ${record.title}`}>
                            <span className="collab-recent-role" data-role={record.permission}>{record.permission === "host" ? t`host` : t`joined`}</span>
                            <span className="collab-recent-name">{record.title}</span>
                            <time
                              className="collab-recent-time"
                              dateTime={new Date(createdAt).toISOString()}
                              title={new Date(createdAt).toLocaleString(i18n.locale)}
                            >
                              {roomRelativeTime(createdAt, i18n.locale)}
                            </time>
                            <span className="collab-recent-code">{record.projectInstanceId} · {record.permission}</span>
                          </button>
                          {record.permission === "host" ? (
                            <>
                              <Button size="compact" variant="ghost" onClick={() => beginRename(record)}>{t`Rename`}</Button>
                              {/* The only way to end a room you left. Styled as the destructive action it is. */}
                              <Button
                                size="compact"
                                variant="danger"
                                title={t`End “${record.title}” for everyone and remove it from this Mac`}
                                onClick={() => props.onCloseProjectV2?.(record)}
                              >
                                {t`Close for everyone`}
                              </Button>
                            </>
                          ) : null}
                          {record.permission === "host" ? null : (
                            <IconButton size="compact" tooltip={false} className="collab-recent-forget" label={t`Remove ${record.projectInstanceId} from recent shares`} onClick={() => props.onForgetProjectV2?.(record)}><X size={12} /></IconButton>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          </div>
        ) : null}

        {!live && mode === "join" ? (
          <div className="collab-mode-panel">
            <label>
              {t`Invite link`}
              <Textarea
                aria-label={t`Collab invite`}
                className="native-hover-scrollbar"
                placeholder={t`Paste the full invite from Copy invite`}
                value={props.inviteText}
                rows={3}
                onChange={(event) => props.onInviteChange(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        {live ? (
          <div className="collab-live-card">
            {chatEnabled ? (
              <SegmentedControl
                value={liveTab}
                onChange={setLiveTab}
                ariaLabel={t`Live collaboration view`}
                className="collab-live-tabs"
                items={[
                  { value: "status", label: t`status` },
                  {
                    value: "chat",
                    label: <>{t`chat`}{(props.chatUnread ?? 0) > 0
                      ? <em className="collab-peer-badge">{props.chatUnread}</em>
                      : null}</>,
                  },
                ]}
              />
            ) : null}

            {sendChat && liveTab === "chat" ? (
              <CollabChatPanel
                messages={props.chatMessages ?? []}
                selfId={props.chatSelfId ?? ""}
                onSend={sendChat}
              />
            ) : (
              <>
                <div className="collab-status-line" data-status={props.status}>
                  {props.status === "connecting" && <InfinityLoader size={12} />}
                  <span>
                    {props.status === "synced"
                      ? t({ message: `${roleLabel} · all project files · ${fileCountLabel} · ${othersLabel} · ${connectedRoomLabel}` })
                      : props.statusDetail || t`Connecting…`}
                  </span>
                </div>
                {props.role === "host" ? (
                  <>
                    <code className="collab-invite-code">{formatInvitePreview(props.host, props.room)}</code>
                    <button type="button" className="collab-copy-button" onClick={() => { void copyInvite(); }}>
                      <IconSwap swapKey={copied ? "check" : "copy"}>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                      </IconSwap>
                      {copied ? t`Copied` : t`Copy invite`}
                    </button>
                  </>
                ) : null}
                {/*
                  Everyone sees the room's roster, not just the host: without it
                  a guest has no way to tell who started the share — and so no
                  way to know who can end it — since every guest's own controls
                  look identical. `host` comes from the coordinator's presence
                  table, which stamps the authenticated permission server-side.
                */}
                <div className="collab-participants">
                  <div className="collab-participants-title">{t`In this room`}</div>
                  <ul className="collab-participants-list">
                    <li className="collab-participant-row">
                      <span className="collab-participant-name">
                        {props.displayName.trim() || t`You`} <span className="collab-participant-you">{t`(you)`}</span>
                        {props.role === "host" ? <em className="collab-participant-role">{t`host`}</em> : null}
                      </span>
                    </li>
                    {(props.peers ?? []).map((peer) => (
                      <li key={peer.clientId} className="collab-participant-row">
                        <span className="collab-participant-name">
                          {peer.name}
                          {peer.permission === "host" ? <em className="collab-participant-role">{t`host`}</em> : null}
                        </span>
                        {peer.path ? <span className="collab-participant-path">{peer.path}</span> : null}
                        {peer.grantId && props.role === "host" && props.onRemovePeer ? (
                          <Button
                            size="compact"
                            variant="ghost"
                            className="collab-remove-peer"
                            disabled={removingPeer === peer.grantId}
                            aria-label={t`Remove ${peer.name} from this share`}
                            onClick={() => { void removePeer(peer); }}
                          >
                            {removingPeer === peer.grantId ? t`Removing…` : t`Remove`}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
                {props.role === "guest" ? (
                  <p className="collab-help">
                    {t({ message: "You are in a shared workspace. Leave share returns you to your previous project; the host keeps sharing" })}
                  </p>
                ) : (
                  <>
                    <p className="collab-help">
                      {localHost
                        ? t`This session uses a local sync host, so only people on your network can join. Use a build configured with a public sync host to collaborate remotely`
                        : t`Send the invite above. They open Live collaboration → Join → paste → Join share. Lattice opens a new folder under Documents/Lattice Shares for them`}
                    </p>
                    <p className="collab-help">
                      {t`You started this share. `}<strong>{t`Leave share`}</strong>{t({ message: " (or switching projects) only disconnects you — the room keeps running and you can rejoin it from Your shared rooms. " })}<strong>{t`Stop sharing`}</strong>{t` ends it for everyone`}
                    </p>
                  </>
                )}
                {props.onInstallTex ? (
                  <p className="collab-help">
                    {t`Compile/PDF stays on each Mac. `}
                    <Button size="compact" variant="ghost" className="collab-inline-link" onClick={props.onInstallTex}>
                      {t`Install LaTeX tools`}
                    </Button>
                    {t` if Build fails on a blank machine`}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : starting ? (
          <div className="collab-status-line" data-status={props.status} role="status" aria-live="polite">
            <InfinityLoader size={12} />
            <span>{props.statusDetail || t`Connecting…`}</span>
          </div>
        ) : props.status === "error" ? (
          <div className="collab-status-line" data-status={props.status} role="status">
            <span>{props.statusDetail || t`Connection failed`}</span>
          </div>
        ) : null}

        <div className="modal-actions">
          {starting ? (
            <MotionButton type="button" className={buttonClassName({ variant: "primary" })} onClick={props.onDisconnect}>
              {t`Cancel`}
            </MotionButton>
          ) : live ? (
            <>
              {/*
                The host gets both exits as separate buttons instead of one
                label that changes with the role: leaving and ending the room
                for everyone are different decisions, and collapsing them left
                every participant looking at the same "Leave share".
              */}
              <MotionButton
                type="button"
                className={buttonClassName({ variant: props.role === "host" ? "secondary" : "primary" })}
                onClick={() => void leaveShare()}
              >
                {t`Leave share`}
              </MotionButton>
              {props.role === "host" ? (
                <MotionButton type="button" className={buttonClassName({ variant: "danger" })} onClick={() => void stopSharing()}>
                  {t`Stop sharing`}
                </MotionButton>
              ) : null}
            </>
          ) : mode === "start" ? (
            <MotionButton
              type="button"
              className={buttonClassName({ variant: "primary" })}
              disabled={!nameReady || !roomNameReady}
              onClick={props.onStartShare}
            >
              {t`Start sharing`}
            </MotionButton>
          ) : (
            <MotionButton
              type="button"
              className={buttonClassName({ variant: "primary" })}
              disabled={!nameReady}
              onClick={props.onJoinShare}
            >
              {t`Join share`}
            </MotionButton>
          )}
        </div>
      </div>
    </ResizableDrawer>
  );
}

function formatInvitePreview(host: string, room: string): string {
  return `lattice:${host}/${room}`;
}
