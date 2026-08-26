import { useState } from "react";
import { MotionButton, PopIn } from "../components/ui/motion";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { Input } from "../components/ui/input";
import { ModalDialog } from "../components/ui/modal-dialog";

export function GotoLineDialog(props: {
  open: boolean;
  line: number;
  maxLine: number;
  onClose: () => void;
  onGoto: (line: number) => void;
}) {
  if (!props.open) return null;
  return (
    <GotoLineDialogForm
      key={`${props.line}:${props.open}`}
      line={props.line}
      maxLine={props.maxLine}
      onClose={props.onClose}
      onGoto={props.onGoto}
    />
  );
}

function GotoLineDialogForm(props: {
  line: number;
  maxLine: number;
  onClose: () => void;
  onGoto: (line: number) => void;
}) {
  const [value, setValue] = useState(String(props.line));
  const submit = () => {
    const line = Number(value);
    if (!Number.isFinite(line)) return;
    props.onGoto(Math.min(props.maxLine, Math.max(1, Math.round(line))));
  };

  return (
    <ModalDialog label="Go to line" onClose={props.onClose}>
      <PopIn className="modal goto-line-modal">
        <h2>Go to line</h2>
        <p>Enter a line between 1 and {props.maxLine}</p>
        <label>
          Line
          <Input
            controlSize="form"
            autoFocus
            aria-label="Line number"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        </label>
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <MotionButton type="button" className={buttonClassName({ variant: "primary" })} onClick={submit}>Go</MotionButton>
        </div>
      </PopIn>
    </ModalDialog>
  );
}
