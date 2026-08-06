import { useEffect, useState } from "react";
import { Check, Copy, Radio, X } from "lucide-react";
import { IconSwap, MotionButton } from "./motion";
import { confirmAction } from "./app-utils";
import { isLocalCollabHost } from "./collab-config";
import type { CollabChatMessage, CollabPeer, CollabStatus } from "./collab-session";
import type { CollabProjectRecordV2 } from "./collab-rooms";
import { CollabChatPanel } from "./collab-chat";
import { Button } from "./components/ui/button";
import { InfinityLoader } from "./components/ui/activity-icons";
import { buttonClassName } from "./components/ui/button-styles";
import { IconButton } from "./components/ui/icon-button";
import { Input } from "./components/ui/input";
import { PanelHeader } from "./components/ui/panel-header";
import { rowClassName } from "./components/ui/row";
import { ScrollArea } from "./components/ui/scroll-area";
import { SegmentedControl } from "./components/ui/segmented-control";
import { Textarea } from "./components/ui/textarea";
import { ResizableDrawer } from "./resizable-drawer";

export type CollabDialogMode = "start" | "join";
/** Which half of the live card is showing. Chat only exists once a room is live. */
type CollabLiveTab = "status" | "chat";

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
  const recentRooms = (props.recentProjectsV2 ?? []).filter((record) => (
    mode === "start" ? record.permission === "host" : record.permission !== "host"
  ));
  const recentRoomsTitle = mode === "start" ? "Rooms you host" : "Rooms you joined";
  const othersLabel = props.peerCount === 0
    ? "just you"
    : props.peerCount === 1
      ? "1 other"
      : `${props.peerCount} others`;

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
      "Stop sharing for everyone?\n\nCollaborators will be disconnected and returned to their previous projects. This cannot be undone — reopening the room means sending a new invite.",
    );
    if (!ok) return;
    props.onDisconnect();
  };

  const removePeer = async (peer: CollabPeer) => {
    if (!peer.grantId || !props.onRemovePeer) return;
    if (!await confirmAction(`Remove ${peer.name}?\n\nThey will lose access immediately. Anyone who joined with the same invite will also lose access.`)) return;
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
      ariaLabel="Live collaboration"
      onClose={props.onClose}
    >
      <PanelHeader
        className="drawer-header"
        icon={<Radio size={16} />}
        title="Live collaboration"
        onClose={props.onClose}
      />
      <div className="modal collab-modal collab-drawer-content">
        <p>
          Share sources, figures, papers, and comments in real time — including each other’s
          named cursors in the editor. Joining opens a new folder under Documents/Lattice Shares;
          your other local projects are never modified. Rebuild the PDF locally after sync.
        </p>

        {!live && !props.joinOnly ? (
          <SegmentedControl
            value={mode}
            onChange={props.onModeChange}
            ariaLabel="Share mode"
            size="default"
            tone="accent"
            className="collab-mode-switch"
            items={[
              { value: "start", label: "Start sharing" },
              { value: "join", label: "Join" },
            ]}
          />
        ) : null}

        <div className="collab-field">
          <label>
            Your name
            <Input
              controlSize="form"
              aria-label="Collab display name"
              placeholder="Ada"
              value={props.displayName}
              disabled={live}
              onChange={(event) => props.onDisplayNameChange(event.target.value)}
            />
          </label>
          {!live && !nameReady ? (
            <p className="collab-help collab-name-help">Enter your name so others can see who is editing.</p>
          ) : null}
        </div>

        {!live && mode === "start" && !props.joinOnly ? (
          <label>
            Room name
            <Input
              controlSize="form"
              aria-label="Collab room name"
              placeholder="Attention paper"
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
                            aria-label={`Rename ${record.title}`}
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
                          <Button size="compact" type="submit">Save</Button>
                          <Button size="compact" variant="ghost" type="button" onClick={cancelRename}>Cancel</Button>
                        </form>
                      ) : (
                        <>
                          <button type="button" className={rowClassName("data", "collab-recent-item")} onClick={() => props.onRejoinProjectV2?.(record)} title={`Rejoin ${record.title}`}>
                            <span className="collab-recent-role" data-role={record.permission}>{record.permission === "host" ? "host" : "joined"}</span>
                            <span className="collab-recent-name">{record.title}</span>
                            <span className="collab-recent-code">{record.projectInstanceId} · {record.permission}</span>
                          </button>
                          {record.permission === "host" ? (
                            <>
                              <Button size="compact" variant="ghost" onClick={() => beginRename(record)}>Rename</Button>
                              {/* The only way to end a room you left. Styled as the destructive action it is. */}
                              <Button
                                size="compact"
                                variant="danger"
                                title={`End “${record.title}” for everyone and remove it from this Mac`}
                                onClick={() => props.onCloseProjectV2?.(record)}
                              >
                                Close for everyone
                              </Button>
                            </>
                          ) : null}
                          {/*
                            Close is the right exit for a room you host, but it
                            cannot be the only one: a room the server has
                            already reclaimed can never be closed, and without
                            this the row was stuck in the list for good. The
                            handler warns a host that removing the entry leaves
                            the room running.
                          */}
                          <IconButton size="compact" tooltip={false} className="collab-recent-forget" label={`Remove ${record.projectInstanceId} from recent shares`} onClick={() => props.onForgetProjectV2?.(record)}><X size={12} /></IconButton>
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
              Invite link
              <Textarea
                aria-label="Collab invite"
                className="native-hover-scrollbar"
                placeholder="Paste the full invite from Copy invite"
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
                ariaLabel="Live collaboration view"
                className="collab-live-tabs"
                items={[
                  { value: "status", label: "status" },
                  {
                    value: "chat",
                    label: <>chat{(props.chatUnread ?? 0) > 0
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
                      ? `${props.role === "guest" ? "Joined" : "Sharing"} · all project files · ${props.fileCount} files · ${othersLabel} · ${props.connectedRoom}`
                      : props.statusDetail || "Connecting…"}
                  </span>
                </div>
                {props.role === "host" ? (
                  <>
                    <code className="collab-invite-code">{formatInvitePreview(props.host, props.room)}</code>
                    <button type="button" className="collab-copy-button" onClick={() => { void copyInvite(); }}>
                      <IconSwap swapKey={copied ? "check" : "copy"}>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                      </IconSwap>
                      {copied ? "Copied" : "Copy invite"}
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
                  <div className="collab-participants-title">In this room</div>
                  <ul className="collab-participants-list">
                    <li className="collab-participant-row">
                      <span className="collab-participant-name">
                        {props.displayName.trim() || "You"} <span className="collab-participant-you">(you)</span>
                        {props.role === "host" ? <em className="collab-participant-role">host</em> : null}
                      </span>
                    </li>
                    {(props.peers ?? []).map((peer) => (
                      <li key={peer.clientId} className="collab-participant-row">
                        <span className="collab-participant-name">
                          {peer.name}
                          {peer.permission === "host" ? <em className="collab-participant-role">host</em> : null}
                        </span>
                        {peer.path ? <span className="collab-participant-path">{peer.path}</span> : null}
                        {peer.grantId && props.role === "host" && props.onRemovePeer ? (
                          <Button
                            size="compact"
                            variant="ghost"
                            className="collab-remove-peer"
                            disabled={removingPeer === peer.grantId}
                            aria-label={`Remove ${peer.name} from this share`}
                            onClick={() => { void removePeer(peer); }}
                          >
                            {removingPeer === peer.grantId ? "Removing…" : "Remove"}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
                {props.role === "guest" ? (
                  <p className="collab-help">
                    You are in a shared workspace. Leave share returns you to your previous project;
                    the host keeps sharing.
                  </p>
                ) : (
                  <>
                    <p className="collab-help">
                      {localHost
                        ? "This session uses a local sync host, so only people on your network can join. Use a build configured with a public sync host to collaborate remotely."
                        : "Send the invite above. They open Live collaboration → Join → paste → Join share. Lattice opens a new folder under Documents/Lattice Shares for them."}
                    </p>
                    <p className="collab-help">
                      You started this share. <strong>Leave share</strong> (or switching projects) only
                      disconnects you — the room keeps running and you can rejoin it from Your shared
                      rooms. <strong>Stop sharing</strong> ends it for everyone.
                    </p>
                  </>
                )}
                {props.onInstallTex ? (
                  <p className="collab-help">
                    Compile/PDF stays on each Mac.{" "}
                    <Button size="compact" variant="ghost" className="collab-inline-link" onClick={props.onInstallTex}>
                      Install LaTeX tools
                    </Button>
                    {" "}if Build fails on a blank machine.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : starting ? (
          <div className="collab-status-line" data-status={props.status} role="status" aria-live="polite">
            <InfinityLoader size={12} />
            <span>{props.statusDetail || "Connecting…"}</span>
          </div>
        ) : props.status === "error" ? (
          <div className="collab-status-line" data-status={props.status} role="status">
            <span>{props.statusDetail || "Connection failed"}</span>
          </div>
        ) : null}

        <div className="modal-actions">
          {starting ? (
            <MotionButton type="button" className={buttonClassName({ variant: "primary" })} onClick={props.onDisconnect}>
              Cancel
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
                Leave share
              </MotionButton>
              {props.role === "host" ? (
                <MotionButton type="button" className={buttonClassName({ variant: "danger" })} onClick={() => void stopSharing()}>
                  Stop sharing
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
              Start sharing
            </MotionButton>
          ) : (
            <MotionButton
              type="button"
              className={buttonClassName({ variant: "primary" })}
              disabled={!nameReady}
              onClick={props.onJoinShare}
            >
              Join share
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
