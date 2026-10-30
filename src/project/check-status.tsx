import { Check, Minus } from "lucide-react";

/**
 * A check's result as a mark, so colour never carries it alone: a tick when it
 * passes, an exclamation when it needs attention, a dash when it cannot be
 * settled. Lucide has no bare exclamation, so that one is drawn here from the
 * strokes of its CircleAlert.
 */
export function CheckStatus(props: { ok: boolean | null }) {
  return (
    <i className="checklist-status" aria-hidden="true">
      {props.ok == null
        ? <Minus size={12} />
        : props.ok
          ? <Check size={12} />
          : (
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M12 5v9M12 19h.01" />
            </svg>
          )}
    </i>
  );
}
