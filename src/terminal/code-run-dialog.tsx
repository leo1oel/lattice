import { useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { PanelHeader } from "../components/ui/panel-header";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { InlineMessage } from "../components/ui/inline-message";
import { useTrellisApp, type TrellisController } from "../trellis/trellis-controller";
import { defaultCodeProgram, runProjectCode, type CodeRunConfig } from "./code-run";
import { followProject, terminals } from "./terminal-window";
import "./code-run.css";

type State = { program: string; programArgs: string; scriptArgs: string; busy: boolean; error: boolean };
type Action = { type: "edit"; field: "program" | "programArgs" | "scriptArgs"; value: string } | { type: "running" } | { type: "failed" };
function reducer(state: State, action: Action): State {
  if (action.type === "edit") return { ...state, [action.field]: action.value, error: false };
  return { ...state, busy: action.type === "running", error: action.type === "failed" };
}
function argumentsList(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
  return parsed;
}

async function executeCodeRun(controller: TrellisController, state: State, dispatch: (action: Action) => void, onClose: () => void) {
  dispatch({ type: "running" });
  try {
    const config: CodeRunConfig = { program: state.program, programArgs: argumentsList(state.programArgs), scriptArgs: argumentsList(state.scriptArgs) };
    followProject(controller);
    if (!(await runProjectCode(controller, terminals, config))) throw new Error();
    onClose();
  } catch { dispatch({ type: "failed" }); }
}

export function CodeRunDialog({ controller, onClose }: { controller: TrellisController; onClose: () => void }) {
  const { t } = useLingui();
  const path = useTrellisApp(controller, (state) => state.activeKey);
  const [state, dispatch] = useReducer(reducer, { program: defaultCodeProgram(path), programArgs: "[]", scriptArgs: "[]", busy: false, error: false });
  return (
    <SheetDialog className="project-replace code-run-dialog" label={t`Run current file`} dirty={state.busy} onClose={() => { if (!state.busy) onClose(); }}>
        <PanelHeader className="drawer-header" title={t`Run current file`} onClose={() => { if (!state.busy) onClose(); }} />
        <p className="drawer-copy">{t`Save this file, then run it in a new terminal in the project folder. The program has the same access as your terminal.`}</p>
        <p><code>{path}</code></p>
        <label>{t`Program or interpreter`}<Input value={state.program} disabled={state.busy} onChange={(event) => dispatch({ type: "edit", field: "program", value: event.target.value })} /></label>
        <label>{t`Program arguments (JSON array)`}<Input value={state.programArgs} disabled={state.busy} onChange={(event) => dispatch({ type: "edit", field: "programArgs", value: event.target.value })} /></label>
        <label>{t`Script arguments (JSON array)`}<Input value={state.scriptArgs} disabled={state.busy} onChange={(event) => dispatch({ type: "edit", field: "scriptArgs", value: event.target.value })} /></label>
        {state.error && <InlineMessage level="error">{t`Could not run this file. Use a program name or absolute interpreter path and JSON arrays of strings. Check that the file saved successfully.`}</InlineMessage>}
        <div className="dialog-actions">
          <Button variant="ghost" disabled={state.busy} onClick={onClose}>{t`Cancel`}</Button>
          <Button variant="primary" disabled={!path || !state.program.trim() || state.busy} onClick={() => void executeCodeRun(controller, state, dispatch, onClose)}>{t`Save and run`}</Button>
        </div>
    </SheetDialog>
  );
}
