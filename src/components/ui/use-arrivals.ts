import { useReducer } from "react";

type Arrivals = {
  /** The list and readiness last seen, so a render can tell they changed. */
  signature: string;
  ready: boolean;
  seen: ReadonlySet<string> | null;
  fresh: ReadonlySet<string>;
};
type Seen = { signature: string; ready: boolean };

const NONE: ReadonlySet<string> = new Set();

function see(state: Arrivals, { signature, ready }: Seen): Arrivals {
  const next = { ...state, signature, ready };
  if (!ready) return next;
  const keys = signature ? signature.split("\n") : [];
  if (!state.seen) return { ...next, seen: new Set(keys), fresh: NONE };
  const arrived = keys.filter((key) => !state.seen!.has(key));
  if (!arrived.length) return next;
  return { ...next, seen: new Set([...state.seen, ...arrived]), fresh: new Set(arrived) };
}

/**
 * The keys of a list that joined it while it was on screen, for a moment's
 * mark on what is new (a comment thread a co-author just started). What the
 * list held when it was first `ready` is its baseline and never counts, so
 * opening a panel or loading it marks nothing; only the latest arrivals are
 * fresh, so a mark plays once.
 */
export function useArrivals(keys: readonly string[], ready = true): ReadonlySet<string> {
  // One string, so a list rebuilt with the same keys is no change.
  const signature = keys.join("\n");
  const [arrivals, dispatch] = useReducer(see, { signature, ready }, (seen) => see({ signature: "", ready: false, seen: null, fresh: NONE }, seen));
  // Seen in the render that brings the change, so the mark is there when the new key first draws.
  if (arrivals.signature !== signature || arrivals.ready !== ready) dispatch({ signature, ready });
  return arrivals.fresh;
}
