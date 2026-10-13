/**
 * Who else is in the Overleaf project, in the toolbar: stacked initials for
 * the browser collaborators Overleaf's realtime channel tells us about, and a
 * card on hover or focus saying who is where, each row a jump there. Each
 * avatar is still a jump button of its own, so the keyboard path does not go
 * through the card (Radix keeps a hover card out of the tab order). This
 * owns rendering only: the roster comes from `useOverleafPresence`, and
 * resolving a document id to a file path or acting on a click is entirely the
 * caller's business — this component has no notion of "the project" at all.
 */
import { useLingui } from "@lingui/react/macro";
import { MessagesSquare } from "lucide-react";
import type { PresenceUser } from "./use-overleaf-presence";
import { AvatarGroup } from "../components/ui/avatar-group";
import { hueColor, peerInitials } from "../components/ui/collab-colors";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card";
import { PersonAvatar } from "./overleaf-person-avatar";
import "./overleaf-presence.css";

const MAX_AVATARS = 5;

export function OverleafPresenceAvatars(props: {
  peers: PresenceUser[];
  /** The connection dropped: these are who was here, shown dimmed until it is back. */
  reconnecting?: boolean;
  /** Resolve a document id to the project-relative path each person is shown in. */
  pathForDoc: (docId: string) => string | null;
  /** Jump to where this person is; the caller owns opening the file and moving the caret. */
  onJump: (peer: PresenceUser) => void;
  /** Open the project chat. */
  onMessageEveryone: () => void;
}) {
  const { t } = useLingui();
  const { peers } = props;
  if (!peers.length) return null;
  const shown = peers.slice(0, MAX_AVATARS);
  const overflow = peers.slice(MAX_AVATARS);

  // A person's place: the file and line their caret is on, as Overleaf counts lines.
  const where = (peer: PresenceUser) => {
    const path = peer.docId ? props.pathForDoc(peer.docId) : null;
    if (!path) return null;
    if (peer.row === null) return path;
    const line = peer.row + 1;
    return t`${path} · line ${line}`;
  };

  return (
    <HoverCard openDelay={280} closeDelay={120}>
      <HoverCardTrigger asChild>
        <span className="overleaf-presence-trigger">
          <AvatarGroup
            className={props.reconnecting ? "overleaf-presence-avatars reconnecting" : "overleaf-presence-avatars"}
            ariaLabel={props.reconnecting ? t`Reconnecting to Overleaf — people last seen in this project` : t`People in this Overleaf project`}
          >
            {shown.map((peer) => {
              const label = peer.name || t`Anonymous`;
              const place = where(peer);
              const name = place ? t`${label} · ${place} — click to jump there` : label;
              return (
                <button
                  key={peer.id}
                  type="button"
                  className="overleaf-presence-avatar"
                  style={{ background: hueColor(peer.hue) }}
                  aria-label={props.reconnecting ? t`${name} (reconnecting…)` : name}
                  onClick={() => props.onJump(peer)}
                >
                  {peerInitials(label)}
                </button>
              );
            })}
            {overflow.length > 0 && (
              <span className="overleaf-presence-avatar more" role="img" aria-label={overflow.map((peer) => peer.name || t`Anonymous`).join(", ")}>
                +{overflow.length}
              </span>
            )}
          </AvatarGroup>
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="overleaf-presence-card">
        <p className="overleaf-presence-card-head">
          {props.reconnecting
            ? t`Reconnecting to Overleaf…`
            : peers.length === 1 ? t`1 person on Overleaf now` : t`${peers.length} people on Overleaf now`}
        </p>
        {peers.map((peer) => {
          const label = peer.name || t`Anonymous`;
          return (
            <button key={peer.id} type="button" className="overleaf-presence-card-row" onClick={() => props.onJump(peer)}>
              <PersonAvatar name={label} color={hueColor(peer.hue)} size="large" />
              <span className="overleaf-presence-card-who">
                <strong>{label}</strong>
                <span>{where(peer) ?? t`Not in a file`}</span>
              </span>
            </button>
          );
        })}
        <button type="button" className="overleaf-presence-card-chat" onClick={props.onMessageEveryone}>
          <MessagesSquare size={14} aria-hidden="true" />
          {t`Message everyone in Chat`}
        </button>
      </HoverCardContent>
    </HoverCard>
  );
}
