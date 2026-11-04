import { useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui, Trans } from "@lingui/react/macro";
import { toMessage } from "../app-utils";
import "./headless-agent-controls.css";

type Result = { applied: string[]; blocked: { path: string; reason: string }[] };
type State = { pending: boolean; result: Result | null; error: string | null };
type Action = { type: "start" } | { type: "done"; result: Result } | { type: "error"; error: string };
function reducer(state: State, action: Action): State {
  if (action.type === "start") return { ...state, pending: true, error: null };
  if (action.type === "done") return { pending: false, result: action.result, error: null };
  return { ...state, pending: false, error: action.error };
}
export function HeadlessAgentControls({ projectRoot }: { projectRoot: string }) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reducer, { pending: false, result: null, error: null });
  async function apply() {
    dispatch({ type: "start" });
    try {
      const result = await invoke<Result>("headless_agent_apply", { projectRoot });
      dispatch({ type: "done", result });
    } catch (reason) { dispatch({ type: "error", error: toMessage(reason) }); }
  }
  return <div className="headless-agent-controls">
    <span title={t`The agent edits an isolated copy. Apply checks for concurrent changes. Bibliography, deleted files and binary changes require separate review.`}><Trans>Staged workspace</Trans></span>
    <button type="button" disabled={state.pending} onClick={() => void apply()}><Trans>Apply checked changes</Trans></button>
    {state.result && <details className="headless-agent-result">
      <summary><Trans>Applied: {state.result.applied.length}; needs review: {state.result.blocked.length}</Trans></summary>
      <ul>{state.result.blocked.map((item) => <li key={item.path}>{item.path}</li>)}</ul>
    </details>}
    {state.error && <output role="alert">{state.error}</output>}
  </div>;
}
