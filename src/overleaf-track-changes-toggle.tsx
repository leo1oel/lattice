/**
 * "Record my edits as suggestions" — on or off, for this account only.
 *
 * Overleaf calls the project-wide setting "track changes", but from one
 * collaborator's seat it is entirely a personal switch: turning it on does
 * not touch anyone else's edits, only this account's — which is why this
 * shows "Suggesting" rather than mirroring Overleaf's own setting name. The
 * state itself (`on`) is not owned here; it comes from
 * `useOverleafRealtime.trackChanges`, which is what the editor's own
 * suggestion decorations already key off, so this button can never disagree
 * with what typing actually does.
 */
import { Highlighter, LoaderCircle, Pencil } from "lucide-react";
import "./overleaf-track-changes-toggle.css";

export function OverleafTrackChangesToggle(props: {
  on: boolean;
  /** True once this account is known to be unable to suggest at all (read-only access). */
  disabled: boolean;
  pending: boolean;
  onToggle: (on: boolean) => Promise<void>;
}) {
  return (
    <button
      type="button"
      className={`overleaf-track-changes-toggle${props.on ? " on" : ""}`}
      disabled={props.disabled || props.pending}
      aria-pressed={props.on}
      title={
        props.disabled
          ? "This account cannot suggest changes in this project."
          : props.on
            ? "Your edits are recorded as suggestions for others to accept or reject. Click to edit normally again."
            : "Your edits apply immediately. Click to record them as suggestions instead."
      }
      onClick={() => void props.onToggle(!props.on).catch(() => {
        // The caller surfaces the reason (e.g. through its own error state);
        // this button only needs to not throw into a click handler.
      })}
    >
      {props.pending
        ? <LoaderCircle className="spin" size={13} />
        : props.on ? <Highlighter size={13} /> : <Pencil size={13} />}
      {props.on ? "Suggesting" : "Editing"}
    </button>
  );
}
