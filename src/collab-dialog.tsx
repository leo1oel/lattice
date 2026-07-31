import { useEffect, useState } from "react";
import { Check, Copy, Radio, Users, X } from "lucide-react";
import { IconSwap, MotionButton } from "./motion";
import { isLocalCollabHost } from "./collab-config";
import type { CollabChatMessage, CollabStatus } from "./collab-session";
import type { CollabRoomRecord } from "./collab-rooms";
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
  fileCount: number;
  connectedRoom: string | null;
  /** When true, Start sharing is hidden (e.g. welcome screen Join-only). */
  joinOnly?: boolean;
  onClose: () => void;
  onModeChange: (mode: CollabDialogMode) => void;
  onHostChange: (host: string) => void;
  onRoomChange: (room: string) => void;
  onDisplayNameChange: (name: string) => void;
  onInviteChange: (invite: string) => void;
  onStartShare: () => void;
  onJoinShare: () => void;
  recentRooms: CollabRoomRecord[];
  onReconnectRoom: (record: CollabRoomRecord) => void;
  onForgetRoom: (record: CollabRoomRecord) => void;
  onDisconnect: () => void;
  onCopyInvite: () => Promise<void> | void;
  onInstallTex?: () => void;

  /** Omitting these leaves the live card exactly as it was — chat is opt-in per caller. */
  chatMessages?: CollabChatMessage[];
  chatSelfId?: string;
  chatUnread?: number;
  onChatSend?: (body: string) => void;
  /** Fires whenever the chat tab is the visible one while the dialog is open, to clear the badge. */
  onChatOpen?: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const live = props.connectedRoom != null
    || props.status === "synced"
    || props.status === "connecting";
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

  return (
    <ResizableDrawer
      className="collab-drawer"
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
          <p className="collab-help">Enter your name so others can see who is editing.</p>
        ) : null}

        {!live && props.recentRooms.length > 0 ? (
          <div className="collab-recent">
            <div className="collab-recent-title">Recent shares</div>
            <ul className="collab-recent-list">
              {props.recentRooms.map((record) => (
                <li key={`${record.host}:${record.room}`} className="collab-recent-row">
                  <button
                    type="button"
                    className={rowClassName("data", "collab-recent-item")}
                    onClick={() => props.onReconnectRoom(record)}
                    title={`Reconnect to ${record.room} on ${record.host}`}
                  >
                    <span className="collab-recent-role" data-role={record.role}>
                      {record.role === "host" ? <Radio size={12} /> : <Users size={12} />}
                    </span>
                    <span className="collab-recent-name">{record.title}</span>
                    <span className="collab-recent-code">{record.room}</span>
                  </button>
                  <IconButton
                    size="compact"
                    tooltip={false}
                    className="collab-recent-forget"
                    label={`Remove ${record.room} from recent shares`}
                    onClick={() => props.onForgetRoom(record)}
                  >
                    <X size={12} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Both modes reserve the same space here, so switching never changes
            the dialog's height — a centered dialog that grows would drag the
            mode switch up or down with it. */}
        {!live ? (
          <div className="collab-mode-panel">
            {mode === "join" ? (
              <label>
                Invite link
                <Textarea
                  aria-label="Collab invite"
                  placeholder="Paste the full invite: lattice:host/LT-XXXXXX"
                  value={props.inviteText}
                  rows={3}
                  onChange={(event) => props.onInviteChange(event.target.value)}
                />
              </label>
            ) : (
              <p className="collab-help collab-mode-blurb">
                Starting a share puts this project in a room and gives you an invite to send.
                Everyone you invite edits the same sources with you, and you can stop the share
                at any time.
              </p>
            )}
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
                      ? `${props.role === "guest" ? "Joined" : "Sharing"} · ${props.fileCount} files · ${othersLabel} · ${props.connectedRoom}`
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
                {props.role === "guest" ? (
                  <p className="collab-help">
                    You are in a shared workspace. Leave share returns you to your previous project;
                    the host keeps sharing.
                  </p>
                ) : localHost ? (
                  <p className="collab-help">
                    This session uses a local host. Friends outside your network need a public sync host
                    (one-time <code>pnpm collab:login</code> + <code>pnpm collab:deploy</code>, then Advanced).
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
          <>
            <div className="collab-status-line" data-status={props.status}>
              {props.status === "error" ? <span>{props.statusDetail || "Connection failed"}</span> : null}
            </div>
            <Button
              size="compact"
              variant="ghost"
              className="collab-advanced-toggle"
              onClick={() => setAdvanced((value) => !value)}
            >
              {advanced ? "Hide advanced" : "Advanced (sync host)"}
            </Button>
            {advanced ? (
              <label>
                Sync host
                <Input
                  controlSize="form"
                  aria-label="Collab host"
                  placeholder="lattice-collab.you.workers.dev"
                  value={props.host}
                  onChange={(event) => props.onHostChange(event.target.value)}
                />
              </label>
            ) : null}
            {localHost ? (
              <p className="collab-help">
                Default host is local. Fine for two windows on this Mac; for a remote friend, run
                {" "}<code>pnpm collab:login</code> then <code>pnpm collab:deploy</code>, and paste the
                {" "}<code>*.workers.dev</code> host under Advanced (saved for next time).
              </p>
            ) : (
              <p className="collab-help">
                Use the full invite from Copy invite (includes the sync host). Room codes alone
                only work if both of you already use the same host.
              </p>
            )}
          </>
        )}

        <div className="modal-actions">
          {live ? (
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
