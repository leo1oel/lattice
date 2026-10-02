import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { MotionButton } from "../components/ui/motion";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { Input } from "../components/ui/input";
import { ModalDialog } from "../components/ui/modal-dialog";

type GotoLineDialogProps = {
  open: boolean;
  line: number;
  maxLine: number;
  onClose: () => void;
  onGoto: (line: number) => void;
};

export function GotoLineDialog(props: GotoLineDialogProps) {
  // Keyed by the starting line so each opening begins from a fresh draft.
  return props.open ? <GotoLineDialogForm key={props.line} {...props} /> : null;
}

function GotoLineDialogForm(props: GotoLineDialogProps) {
  const { t } = useLingui();
  const maxLine = props.maxLine;
  const [value, setValue] = useState(String(props.line));
  const submit = () => {
    const line = Number(value);
    if (!Number.isFinite(line)) return;
    props.onGoto(Math.min(props.maxLine, Math.max(1, Math.round(line))));
  };

  return (
    <ModalDialog label={t`Go to line`} onClose={props.onClose}>
      <div className="modal goto-line-modal">
        <h2><Trans>Go to line</Trans></h2>
        <p>{t`Enter a line between 1 and ${maxLine}`}</p>
        <label>
          <Trans>Line</Trans>
          <Input
            controlSize="form"
            autoFocus
            aria-label={t`Line number`}
            value={value}
            // The current line starts selected, so typing a number replaces
            // it: appended, "3" then "150" went to line 3150.
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        </label>
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}><Trans>Cancel</Trans></Button>
          <MotionButton type="button" className={buttonClassName({ variant: "primary" })} onClick={submit}><Trans>Go</Trans></MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
