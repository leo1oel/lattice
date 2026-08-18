/**
 * Who else is in the Overleaf project, in the toolbar.
 *
 * Stacked initials, in the style of Lattice's own live-share avatars — but for
 * the browser collaborators Overleaf's realtime channel tells us about, which
 * is a separate roster from Lattice's own P2P sessions and can be live at the
 * same time. This owns rendering only: the roster comes from
 * `useOverleafPresence`, and resolving a document id to a file path or acting
 * on a click is entirely the caller's business — this component has no notion
 * of "the project" at all.
 */
import { peerInitials } from "../collab/collab-session";
import type { PresenceUser } from "./use-overleaf-presence";
import { AvatarGroup } from "../components/ui/avatar-group";
import "./overleaf-presence.css";

const MAX_AVATARS = 5;

export function OverleafPresenceAvatars(props: {
  peers: PresenceUser[];
  /** Resolve a document id to the project-relative path shown in the tooltip. */
  pathForDoc: (docId: string) => string | null;
  /** Jump to where this person is; the caller owns opening the file and moving the caret. */
  onJump: (peer: PresenceUser) => void;
}) {
  const { peers } = props;
  if (!peers.length) return null;
  const shown = peers.slice(0, MAX_AVATARS);
  const overflow = peers.slice(MAX_AVATARS);

  return (
    <AvatarGroup className="overleaf-presence-avatars" ariaLabel="People in this Overleaf project">
      {shown.map((peer) => {
        const label = peer.name || "Anonymous";
        const path = peer.docId ? props.pathForDoc(peer.docId) : null;
        const title = path ? `${label} · ${path} — click to jump there` : label;
        return (
          <button
            key={peer.id}
            type="button"
            className="overleaf-presence-avatar"
            style={{ background: `hsl(${peer.hue}, 70%, 50%)` }}
            title={title}
            onClick={() => props.onJump(peer)}
          >
            {peerInitials(label)}
          </button>
        );
      })}
      {overflow.length > 0 && (
        <span
          className="overleaf-presence-avatar more"
          title={overflow.map((peer) => peer.name || "Anonymous").join(", ")}
        >
          +{overflow.length}
        </span>
      )}
    </AvatarGroup>
  );
}
