import { useEffect, useRef, useState } from "react";
import { springExit } from "../../components/ui/motion-values";

/** A card leaving the list (resolved out of its filter, or deleted) goes on the moderate exit, then the change lands. */
export const LEAVE_MS = springExit.moderate.duration * 1000;
/** How long a card says what just happened to it ("Saved", "Reply sent") before the line settles. */
export const CONFIRM_MS = 1_800;

/** What the writer just did to an annotation card, as the card answers it. */
export type CardOutcome = "resolved" | "reopened" | "saved" | "replied";

type Answered = {
  outcome: CardOutcome;
  /** How many replies the note had before a reply was sent, so the new one can arrive. */
  replies: number;
  /** Which answer this is, so an earlier one's timer does not end a later one. */
  token: number;
};

/**
 * How the Annotations panel's cards answer what the writer does to them:
 * `leave` plays a card's exit and lands the change after it, and `answer`
 * has a card that stays say what happened for a moment. Timers end with the
 * panel.
 */
export function useCardOutcomes() {
  /** Cards on their way out; the change they leave for lands when the exit ends. */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Answered>>(() => new Map());
  const timers = useRef<number[]>([]);
  const tokens = useRef(0);
  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
  }, []);
  const later = (ms: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, ms));
  };

  const answer = (id: string, outcome: CardOutcome, replies = 0) => {
    const token = ++tokens.current;
    setOutcomes((current) => new Map(current).set(id, { outcome, replies, token }));
    later(CONFIRM_MS, () => setOutcomes((current) => {
      if (current.get(id)?.token !== token) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    }));
  };

  /** The card leaves, then `change` lands; the toast `change` raises offers it back. */
  const leave = (id: string, change: () => void) => {
    if (leaving.has(id)) return;
    setLeaving((current) => new Set(current).add(id));
    later(LEAVE_MS, () => {
      change();
      setLeaving((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    });
  };

  return { leaving, outcomes, answer, leave };
}
