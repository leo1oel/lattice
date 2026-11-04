import { useEffect, useId, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { InlineMessage } from "../components/ui/inline-message";
import type { OverleafStatus } from "../app-types";

type State = { visible: boolean; cookie: string; busy: boolean; error: string | null };
type Action = { type: "open" | "busy" | "ready" | "clear" } | { type: "edit" | "error"; value: string };
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "open": return { ...state, visible: true, error: null };
    case "busy": return { ...state, busy: true, error: null };
    case "ready": return { ...state, busy: false };
    case "clear": return { ...state, cookie: "", busy: false };
    case "edit": return { ...state, cookie: action.value };
    case "error": return { ...state, error: action.value, busy: false };
  }
}

/** A deliberate session transfer, never browser-cookie database extraction or an OAuth claim. */
export function OverleafBrowserLogin({ host, onConnected }: { host: string; onConnected: (session: OverleafStatus) => void }) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reducer, { visible: false, cookie: "", busy: false, error: null });
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const id = useId();
  useEffect(() => () => { generation.current += 1; if (input.current) input.current.value = ""; }, []);
  const open = async () => {
    dispatch({ type: "open" });
    const current = generation.current;
    try { await invoke("overleaf_open_login_in_browser", { host }); }
    catch {
      if (current === generation.current) dispatch({ type: "error", value: t`Could not open the default browser. Open Overleaf in your browser and continue with the session import below.` });
    }
  };
  const connect = async () => {
    if (state.busy || !state.cookie.trim()) return;
    const current = generation.current;
    dispatch({ type: "busy" });
    try {
      const session = await invoke<OverleafStatus>("overleaf_connect_session", { host, cookie: state.cookie });
      if (current !== generation.current) return;
      // Clear the live DOM before the parent removes this form after connecting.
      if (input.current) input.current.value = "";
      dispatch({ type: "clear" });
      onConnected(session);
    } catch {
      if (current === generation.current) dispatch({ type: "error", value: t`Could not validate that session. Copy a fresh session cookie from a signed-in browser and try again.` });
    }
  };
  return <div className="overleaf-browser-login">
    <Button onClick={() => void open()} disabled={state.busy}>{t`Open in default browser`}</Button>
    {state.visible && <form onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <p className="overleaf-hint">{t`Sign in in your browser, then import its session below. Opening the browser alone does not connect Lattice.`}</p>
      <p className="overleaf-hint">{t`In your browser's developer tools, open Storage or Application → Cookies. Copy the Overleaf session cookie as name=value (overleaf_session2 or sharelatex.sid). Treat it like a password; Lattice validates it before storing it privately.`}</p>
      <label htmlFor={id}>{t`Overleaf session cookie`}</label>
      <Input id={id} ref={input} type="password" autoComplete="off" spellCheck={false} maxLength={16384} value={state.cookie} disabled={state.busy}
        onChange={(event) => dispatch({ type: "edit", value: event.target.value })} />
      <Button type="submit" disabled={state.busy || !state.cookie.trim()}>{t`Import browser session`}</Button>
    </form>}
    {state.error && <InlineMessage level="error">{state.error}</InlineMessage>}
  </div>;
}
