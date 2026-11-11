/**
 * Renaming what reaches past the caret: a label and its \refs, a citation
 * key in its .bib entry and \cites, an environment, or wrapping a selection in
 * one. Loaded when one is asked for.
 */
import { useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { MotionButton } from "../components/ui/motion";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { Input } from "../components/ui/input";
import { ModalDialog } from "../components/ui/modal-dialog";
import type { RenameTarget } from "../app-types";

/** The name being typed, and whether a rename it started is still running. */
type RenameState = { name: string; busy: boolean };
const renameReducer = (state: RenameState, change: Partial<RenameState>) => ({ ...state, ...change });
const startingName = (target: RenameTarget) => (
  target.kind === "label" ? target.label
    : target.kind === "citation" ? target.key
      : target.kind === "environment" ? target.name
        : "equation"
);

export function RenameDialog(props: {
  target: RenameTarget;
  error: string | null;
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const target = props.target;
  const [{ name, busy }, update] = useReducer(renameReducer, target, (initial) => ({ name: startingName(initial), busy: false }));
  // Only a rename that reaches past the cursor says where else it edits.
  const presentations: Record<RenameTarget["kind"], [title: string, copy: string | null]> = {
    label: [t`Rename label`, t`Updates every \\ref to it`],
    citation: [t`Rename citation key`, t`Updates the .bib entry and every \\cite`],
    environment: [t`Rename environment`, null],
    "wrap-environment": [t`Wrap in environment`, null],
  };
  const [title, copy] = presentations[target.kind];
  const submit = async () => {
    if (!name.trim() || busy) return;
    update({ busy: true });
    await props.onRename(name.trim());
    update({ busy: false });
  };
  return (
    <ModalDialog label={title} onClose={props.onClose} closeDisabled={busy}>
      <div className="modal rename-modal">
        <h2>{title}</h2>
        {copy && <p>{copy}</p>}
        <label>
          {t`Name`}
          <Input
            autoFocus
            aria-label={t`New name`}
            value={name}
            onChange={(event) => update({ name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t`Cancel`}</Button>
          <MotionButton
            className={buttonClassName({ variant: "primary" })}
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            {busy ? t`Renaming…` : t`Rename`}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
