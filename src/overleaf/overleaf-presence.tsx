/**
 * Who else is in the Overleaf project, in the toolbar: stacked initials for
 * the browser collaborators Overleaf's realtime channel tells us about. This
 * owns rendering only: the roster comes from `useOverleafPresence`, and
 * resolving a document id to a file path or acting on a click is entirely the
 * caller's business — this component has no notion of "the project" at all.
 */
import { useLingui } from "@lingui/react/macro";
import type { PresenceUser } from "./use-overleaf-presence";
import { AvatarGroup } from "../components/ui/avatar-group";
import { hueColor, peerInitials } from "../components/ui/collab-colors";
import "./overleaf-presence.css";

const MAX_AVATARS = 5;

export function OverleafPresenceAvatars(props: {
  peers: PresenceUser[];
  /** The connection dropped: these are who was here, shown dimmed until it is back. */
  reconnecting?: boolean;
  /** Resolve a document id to the project-relative path shown in the tooltip. */
  pathForDoc: (docId: string) => string | null;
  /** Jump to where this person is; the caller owns opening the file and moving the caret. */
  onJump: (peer: PresenceUser) => void;
}) {
  const { t } = useLingui();
  const { peers } = props;
  if (!peers.length) return null;
  const shown = peers.slice(0, MAX_AVATARS);
  const overflow = peers.slice(MAX_AVATARS);

  return (
    <AvatarGroup
      className={props.reconnecting ? "overleaf-presence-avatars reconnecting" : "overleaf-presence-avatars"}
      ariaLabel={props.reconnecting ? t`Reconnecting to Overleaf — people last seen in this project` : t`People in this Overleaf project`}
    >
      {shown.map((peer) => {
        const label = peer.name || t`Anonymous`;
        const path = peer.docId ? props.pathForDoc(peer.docId) : null;
        const where = path ? t`${label} · ${path} — click to jump there` : label;
        const title = props.reconnecting ? t`${where} (reconnecting…)` : where;
        return (
          <button
            key={peer.id}
            type="button"
            className="overleaf-presence-avatar"
            style={{ background: hueColor(peer.hue) }}
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
          title={overflow.map((peer) => peer.name || t`Anonymous`).join(", ")}
        >
          +{overflow.length}
        </span>
      )}
    </AvatarGroup>
  );
}
