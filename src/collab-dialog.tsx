import { useEffect, useState } from "react";
import { Check, Copy, Radio, X } from "lucide-react";
import { IconSwap, MotionButton } from "./motion";
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
  onInviteChange: (invite: string) => void;
  onStartShare: () => void;
  onJoinShare: () => void;
  recentProjectsV2?: CollabProjectRecordV2[];
  onRejoinProjectV2?: (record: CollabProjectRecordV2) => void;
  onForgetProjectV2?: (record: CollabProjectRecordV2) => void;
  onDisconnect: () => void;
  onCopyInvite: () => Promise<void> | void;
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
  const mode = props.joinOnly ? "join" : props.mode;
  const othersLabel = props.peerCount === 0
    ? "just you"
    : props.peerCount === 1
      ? "1 other"
      : `${props.peerCount} others`;

  const copyInvite = async () => {
    await props.onCopyInvite();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const stopOrLeave = () => {
    if (props.role === "host") {
      const ok = window.confirm(
        "Stop sharing for everyone?\n\nCollaborators will be returned to their previous projects.",
      );
      if (!ok) return;
    }
    props.onDisconnect();
  };

  const removePeer = async (peer: CollabPeer) => {
    if (!peer.grantId || !props.onRemovePeer) return;
    if (!window.confirm(`Remove ${peer.name}?\n\nThey will lose access immediately. Anyone who joined with the same invite will also lose access.`)) return;
    setRemovingPeer(peer.grantId);
    try {
      await props.onRemovePeer(peer);
    } finally {
      setRemovingPeer(null);
    }
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

        {!live && (props.recentProjectsV2?.length ?? 0) > 0 ? (
          <div className="collab-recent">
            <div className="collab-recent-title">Recent shares</div>
            <ul className="collab-recent-list">
              {(props.recentProjectsV2 ?? []).map((record) => (
                <li key={`v2:${record.host}:${record.projectInstanceId}`} className="collab-recent-row">
                  <button type="button" className={rowClassName("data", "collab-recent-item")} onClick={() => props.onRejoinProjectV2?.(record)} title={`Rejoin ${record.title}`}>
                    <span className="collab-recent-role" data-role={record.permission}>v2</span>
                    <span className="collab-recent-name">{record.title}</span>
                    <span className="collab-recent-code">{record.projectInstanceId} · {record.permission}</span>
                  </button>
                  <IconButton size="compact" tooltip={false} className="collab-recent-forget" label={`Remove ${record.projectInstanceId} from recent shares`} onClick={() => props.onForgetProjectV2?.(record)}><X size={12} /></IconButton>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!live && mode === "join" ? (
          <div className="collab-mode-panel">
            <label>
              Invite link
              <Textarea
                aria-label="Collab invite"
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
                    {(props.peers?.length ?? 0) > 0 ? (
                      <div className="collab-participants">
                        <div className="collab-participants-title">Collaborators</div>
                        <ul className="collab-participants-list">
                          {props.peers!.map((peer) => (
                            <li key={peer.clientId} className="collab-participant-row">
                              <span className="collab-participant-name">{peer.name}</span>
                              {peer.path ? <span className="collab-participant-path">{peer.path}</span> : null}
                              {peer.grantId && props.onRemovePeer ? (
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
                    ) : null}
                  </>
                ) : null}
                {props.role === "guest" ? (
                  <p className="collab-help">
                    You are in a shared workspace. Leave share returns you to your previous project;
                    the host keeps sharing.
                  </p>
                ) : localHost ? (
                  <p className="collab-help">
                    This session uses a local sync host, so only people on your network can join.
                    Use a build configured with a public sync host to collaborate remotely.
                    Stop sharing or switch projects ends the session for everyone.
                  </p>
                ) : (
                  <p className="collab-help">
                    Send the invite above. They open Live collaboration → Join → paste → Join share.
                    Lattice opens a new folder under Documents/Lattice Shares for them.
                    Stop sharing or switch projects ends the session for everyone.
                  </p>
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
        ) : (
          props.status === "error" ? (
            <div className="collab-status-line" data-status={props.status}>
              <span>{props.statusDetail || "Connection failed"}</span>
            </div>
          ) : null
        )}

        <div className="modal-actions">
          {starting ? (
            <MotionButton type="button" className={buttonClassName({ variant: "primary" })} onClick={props.onDisconnect}>
              Cancel
            </MotionButton>
          ) : live ? (
            <MotionButton type="button" className={buttonClassName({ variant: "primary" })} onClick={stopOrLeave}>
              {props.role === "guest" ? "Leave share" : "Stop sharing"}
            </MotionButton>
          ) : mode === "start" ? (
            <MotionButton
              type="button"
              className={buttonClassName({ variant: "primary" })}
              disabled={!nameReady}
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
