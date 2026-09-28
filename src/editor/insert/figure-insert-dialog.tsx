import { useState } from "react";
import { ImagePlus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { buttonClassName } from "../../components/ui/button-styles";
import { Input } from "../../components/ui/input";
import { PanelHeader } from "../../components/ui/panel-header";
import { MotionButton, PopIn } from "../../components/ui/motion";
import { DEFAULT_FIGURE_OPTIONS, type FigureInsertOptions } from "./figure-insertion";
import { ModalDialog } from "../../components/ui/modal-dialog";

const FIELDS: Array<[key: keyof FigureInsertOptions, name: string, placeholder?: string]> = [
  ["width", "Width", "0.8\\linewidth"],
  ["placement", "Placement", "t"],
  ["caption", "Caption"],
  ["label", "Label", "fig:name (optional)"],
];

export function FigureInsertDialog(props: {
  open: boolean;
  paths: string[];
  onClose: () => void;
  onInsert: (options: FigureInsertOptions) => void;
}) {
  const [options, setOptions] = useState<Required<FigureInsertOptions>>({ ...DEFAULT_FIGURE_OPTIONS, label: "" });

  if (!props.open || !props.paths.length) return null;

  return (
    <ModalDialog label="Insert figure" onClose={props.onClose}>
      <PopIn className="modal figure-insert-modal">
        <div className="modal-icon"><ImagePlus size={19} /></div>
        <PanelHeader
          className="drawer-header"
          style={{ padding: 0, border: 0, marginBottom: 8 }}
          title="Insert figure"
          onClose={props.onClose}
        />
        <p>{props.paths.length === 1 ? props.paths[0] : `${props.paths.length} figures`}</p>
        {FIELDS.map(([key, name, placeholder]) => (
          <label key={key}>
            {name}
            <Input
              controlSize="form"
              value={options[key]}
              onChange={(event) => setOptions({ ...options, [key]: event.target.value })}
              placeholder={placeholder}
            />
          </label>
        ))}
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <MotionButton
            type="button"
            className={buttonClassName({ variant: "primary" })}
            onClick={() => props.onInsert({ ...options, label: options.label.trim() || undefined })}
          >
            Insert
          </MotionButton>
        </div>
      </PopIn>
    </ModalDialog>
  );
}
