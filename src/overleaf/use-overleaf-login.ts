import { useCallback, useEffect, useRef, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import type { OverleafStatus, OverleafLoginPoll } from "../app-types";
import { toMessage } from "../app-utils";

type LoginState = { pending: boolean; error: string | null; notice: string | null; hint: string | null };
type LoginAction = { type: "pending"; value: boolean } | { type: "error" | "notice" | "hint"; value: string | null };
function loginReducer(state: LoginState, action: LoginAction): LoginState {
  if (action.type === "pending") return { ...state, pending: action.value };
  return { ...state, [action.type]: action.value };
}

// Keep the native action's error boundary outside the hook: the compiler
// cannot lower conditional result handling inside a try/catch block.
async function runLoginPoll(action: () => Promise<void>, onError: (reason: unknown) => void) {
  try { await action(); } catch (reason) { onError(reason); }
}

/**
 * Shared begin-login + poll loop. `overleaf_begin_login` opens a sign-in
 * window and returns immediately; we then poll `overleaf_poll_login` (once
 * right away, then every 1.5s) until the backend reports connected or
 * cancelled. The settings section and the picker both use this so novices
 * can connect from either place without being bounced around the app.
 */
export function useOverleafLogin(onConnected: (session: OverleafStatus) => void) {
  const { t } = useLingui();
  const [{ pending, error, notice, hint }, dispatch] = useReducer(loginReducer, { pending: false, error: null, notice: null, hint: null });
  const attempts = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(false);
  const pollRef = useRef<(() => Promise<void>) | null>(null);
  const connectedRef = useRef(onConnected);
  useEffect(() => { connectedRef.current = onConnected; });

  const stop = useCallback(() => {
    active.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    dispatch({ type: "pending", value: false });
  }, []);
  // Stop polling when the component unmounts (e.g. the dialog closes).
  useEffect(() => stop, [stop]);

  const cancel = useCallback(() => {
    stop();
    dispatch({ type: "notice", value: t`Sign-in was cancelled` });
  }, [stop, t]);

  const poll = useCallback(() => runLoginPoll(async () => {
    if (!active.current) return;
    const result = await invoke<OverleafLoginPoll>("overleaf_poll_login");
    if (!active.current) return;
    if (result.status === "connected" && result.session) {
      stop();
      connectedRef.current(result.session);
      return;
    }
    if (result.status === "cancelled") return cancel();
    // Signing in takes a few seconds, but it should never take half a minute.
    // Rather than spin forever, say what to do next (and why, when the
    // backend got far enough to have a reason).
    attempts.current += 1;
    if (attempts.current >= 20) {
      dispatch({ type: "hint", value:
        result.detail
          ? t`Still not connected: ${result.detail}`
          : t`Still waiting. Cancel this attempt, close the Overleaf window, and try connecting again`,
      });
    }
    timer.current = setTimeout(() => void pollRef.current?.(), 1500);
  }, (reason) => {
    if (!active.current) return;
    stop();
    dispatch({ type: "error", value: toMessage(reason) });
  }), [cancel, stop, t]);
  // A committed callback keeps the next timer on the current locale and
  // handlers without a recursive named expression the compiler cannot hoist.
  useEffect(() => { pollRef.current = poll; }, [poll]);

  const begin = useCallback(() => {
    if (active.current) return;
    dispatch({ type: "error", value: null });
    dispatch({ type: "notice", value: null });
    dispatch({ type: "hint", value: null });
    attempts.current = 0;
    void invoke("overleaf_begin_login", { title: t`Sign in to Overleaf` }).then(() => {
      active.current = true;
      dispatch({ type: "pending", value: true });
      void poll();
    }, (reason) => dispatch({ type: "error", value: toMessage(reason) }));
  }, [poll, t]);

  const accept = (session: OverleafStatus) => { stop(); connectedRef.current(session); };
  return { pending, error, notice, hint, begin, cancel, accept };
}

