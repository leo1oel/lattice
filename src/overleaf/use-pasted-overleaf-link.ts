/**
 * Looking up a project or share link pasted into the "Open from Overleaf"
 * search field (`overleaf_resolve_link`). What the answer says on screen is
 * `overleaf-pasted-link.tsx`.
 */
import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PastedOverleafLink } from "../app-types";

/**
 * Whether search text is a link (or a bare project id) to look up rather than
 * words to filter by: a URL, or a host with a path, as an address bar copies it.
 */
export function looksLikeOverleafLink(text: string): boolean {
  const value = text.trim();
  return /^(https?:\/\/|www\.)\S+$/i.test(value)
    || /^[0-9a-f]{24}$/i.test(value)
    || /^[^\s/]+\.[^\s/]+\/\S+$/.test(value);
}

type Failure = (reason: unknown, report: (message: string) => void) => Promise<void>;

/** The answer for one link and attempt, so a late one for an earlier paste is never shown. */
type Answer = { key: string; answer?: PastedOverleafLink; error?: string };
type LookupState = { attempt: number; settled: Answer | null };
type LookupAction = { type: "retry" } | { type: "settled"; answer: Answer };

function reduceLookup(state: LookupState, action: LookupAction): LookupState {
  switch (action.type) {
    case "retry": return { ...state, attempt: state.attempt + 1 };
    case "settled": return { ...state, settled: action.answer };
  }
}

/**
 * Look up `link` (null: nothing to look up) after a short pause, so typing a
 * link out by hand asks once. `onFailure` turns an expired session into the
 * picker's reconnect state and reports anything else through `report`.
 */
export function usePastedLink(link: string | null, onFailure: Failure) {
  const [{ attempt, settled }, dispatch] = useReducer(reduceLookup, { attempt: 0, settled: null });
  const key = `${attempt}\n${link ?? ""}`;
  useEffect(() => {
    if (!link) return;
    let current = true;
    const settle = (answer: Answer) => { if (current) dispatch({ type: "settled", answer }); };
    const timer = window.setTimeout(() => {
      invoke<PastedOverleafLink>("overleaf_resolve_link", { link })
        .then((answer) => settle({ key, answer }))
        .catch((reason: unknown) => {
          if (current) void onFailure(reason, (error) => settle({ key, error }));
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [key, link, onFailure]);
  const result = link && settled?.key === key ? settled : null;
  return {
    checking: Boolean(link) && !result,
    answer: result?.answer ?? null,
    error: result?.error ?? null,
    retry: () => dispatch({ type: "retry" }),
  };
}
