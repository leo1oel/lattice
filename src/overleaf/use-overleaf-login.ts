import { useCallback, useEffect, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import type { OverleafLoginPoll, OverleafStatus } from "../app-types";
import { toMessage } from "../app-utils";

/** Where the last sign-in attempt stands, as its controls show it. */
type LoginState = {
  pending: boolean;
  error: string | null;
  notice: string | null;
  /** Guidance shown when sign-in has been pending long enough to look stuck. */
  hint: string | null;
};

type LoginAction =
  | { type: "begin" }
  | { type: "waiting" }
  | { type: "stopped" }
  | { type: "notice"; notice: string }
  | { type: "hint"; hint: string }
  | { type: "failed"; error: string };

function reduceLogin(state: LoginState, action: LoginAction): LoginState {
  switch (action.type) {
    case "begin": return { ...state, error: null, notice: null, hint: null };
    case "waiting": return { ...state, pending: true };
    case "stopped": return { ...state, pending: false };
    case "notice": return { ...state, notice: action.notice };
    case "hint": return { ...state, hint: action.hint };
    case "failed": return { ...state, error: action.error };
  }
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
  const [state, dispatch] = useReducer(reduceLogin, { pending: false, error: null, notice: null, hint: null });
  const attempts = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(false);
  const connectedRef = useRef(onConnected);
  useEffect(() => { connectedRef.current = onConnected; });

  const stop = useCallback(() => {
    active.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    dispatch({ type: "stopped" });
  }, []);
  // Stop polling when the component unmounts (e.g. the dialog closes).
  useEffect(() => stop, [stop]);

  const cancel = useCallback(() => {
    stop();
    dispatch({ type: "notice", notice: t`Sign-in was cancelled` });
  }, [stop, t]);

  const poll = useCallback(async function pollForLogin() {
    if (!active.current) return;
    try {
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
        dispatch({
          type: "hint",
          hint: result.detail
            ? t`Still not connected: ${result.detail}`
            : t`Still waiting. Cancel this attempt, close the Overleaf window, and try connecting again`,
        });
      }
      timer.current = setTimeout(() => void pollForLogin(), 1500);
    } catch (reason) {
      if (!active.current) return;
      stop();
      dispatch({ type: "failed", error: toMessage(reason) });
    }
  }, [cancel, stop, t]);

  const begin = useCallback(() => {
    if (active.current) return;
    dispatch({ type: "begin" });
    attempts.current = 0;
    void invoke("overleaf_begin_login", { title: t`Sign in to Overleaf` }).then(() => {
      active.current = true;
      dispatch({ type: "waiting" });
      void poll();
    }, (reason) => dispatch({ type: "failed", error: toMessage(reason) }));
  }, [poll, t]);

  return { ...state, begin, cancel };
}
