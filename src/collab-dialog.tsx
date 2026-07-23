import { useState } from "react";
import { Check, Copy, LoaderCircle, Radio } from "lucide-react";
import { MotionButton, PopIn } from "./motion";
import { isLocalCollabHost } from "./collab-config";
import type { CollabStatus } from "./collab-session";

export type CollabDialogMode = "start" | "join";

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
  onDisconnect: () => void;
  onCopyInvite: () => Promise<void> | void;
  onInstallTex?: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);
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
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <PopIn
        className="modal collab-modal"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Live collaboration"
      >
        <div className="modal-icon"><Radio size={18} /></div>
        <h2>Live collaboration</h2>
        <p>
          Share sources, figures, papers, and comments in real time — including each other’s
          named cursors in the editor. Joining opens a new folder under Documents/Lattice Shares;
          your other local projects are never modified. Rebuild the PDF locally after sync.
        </p>

        {!live && !props.joinOnly ? (
          <div className="collab-mode-switch" role="tablist" aria-label="Share mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "start"}
              className={mode === "start" ? "active" : ""}
              onClick={() => props.onModeChange("start")}
            >
              Start sharing
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "join"}
              className={mode === "join" ? "active" : ""}
              onClick={() => props.onModeChange("join")}
            >
              Join
            </button>
          </div>
        ) : null}

        <label>
          Your name
          <input
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

        {mode === "join" && !live ? (
          <label>
            Invite link
            <textarea
              aria-label="Collab invite"
              placeholder="Paste the full invite: lattice:host/LT-XXXXXX"
              value={props.inviteText}
              rows={3}
              onChange={(event) => props.onInviteChange(event.target.value)}
            />
          </label>
        ) : null}

        {live ? (
          <div className="collab-live-card">
            <div className="collab-status-line" data-status={props.status}>
              {props.status === "connecting" && <LoaderCircle className="spin" size={12} />}
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
                  {copied ? <Check size={14} /> : <Copy size={14} />}
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
                <button type="button" className="text-button collab-inline-link" onClick={props.onInstallTex}>
                  Install LaTeX tools
                </button>
                {" "}if Build fails on a blank machine.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="collab-status-line" data-status={props.status}>
              {props.status === "error" ? <span>{props.statusDetail || "Connection failed"}</span> : null}
            </div>
            <button
              type="button"
              className="text-button collab-advanced-toggle"
              onClick={() => setAdvanced((value) => !value)}
            >
              {advanced ? "Hide advanced" : "Advanced (sync host)"}
            </button>
            {advanced ? (
              <label>
                Sync host
                <input
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
          <button type="button" className="text-button" onClick={props.onClose}>Close</button>
          {live ? (
            <MotionButton type="button" className="primary-button" onClick={stopOrLeave}>
              {props.role === "guest" ? "Leave share" : "Stop sharing"}
            </MotionButton>
          ) : mode === "start" ? (
            <MotionButton
              type="button"
              className="primary-button"
              disabled={!nameReady}
              onClick={props.onStartShare}
            >
              Start sharing
            </MotionButton>
          ) : (
            <MotionButton
              type="button"
              className="primary-button"
              disabled={!nameReady}
              onClick={props.onJoinShare}
            >
              Join share
            </MotionButton>
          )}
        </div>
      </PopIn>
    </div>
  );
}

function formatInvitePreview(host: string, room: string): string {
  return `lattice:${host}/${room}`;
}
