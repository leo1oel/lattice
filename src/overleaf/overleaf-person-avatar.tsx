/**
 * A collaborator's initials on their colour (`personColor` in
 * overleaf-collab-people.ts), so a comment, a suggestion, a chat message and the
 * presence card name someone the same way. Decorative: the name always sits
 * beside it.
 */
import { peerInitials } from "../components/ui/collab-colors";
import "./overleaf-person-avatar.css";

export function PersonAvatar({ name, color, size = "default" }: {
  name: string;
  color: string;
  /** `small` beside a meta line, `default` beside a message, `large` in the presence card. */
  size?: "small" | "default" | "large";
}) {
  return (
    <span className="overleaf-person-avatar" data-size={size} aria-hidden="true" style={{ background: color }}>
      {peerInitials(name)}
    </span>
  );
}
