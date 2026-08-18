import { useState } from "react";
import { ImagePlus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { buttonClassName } from "../../components/ui/button-styles";
import { Input } from "../../components/ui/input";
import { PanelHeader } from "../../components/ui/panel-header";
import { MotionButton, PopIn } from "../../components/ui/motion";
import { DEFAULT_FIGURE_OPTIONS, type FigureInsertOptions } from "./figure-insertion";
import { ModalDialog } from "../../components/ui/modal-dialog";

export function FigureInsertDialog(props: {
  open: boolean;
  paths: string[];
  onClose: () => void;
  onInsert: (options: FigureInsertOptions) => void;
}) {
  const [width, setWidth] = useState(DEFAULT_FIGURE_OPTIONS.width);
  const [placement, setPlacement] = useState(DEFAULT_FIGURE_OPTIONS.placement);
  const [caption, setCaption] = useState(DEFAULT_FIGURE_OPTIONS.caption);
  const [label, setLabel] = useState("");

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
        <label>
          Width
          <Input controlSize="form" value={width} onChange={(event) => setWidth(event.target.value)} placeholder="0.8\linewidth" />
        </label>
        <label>
          Placement
          <Input controlSize="form" value={placement} onChange={(event) => setPlacement(event.target.value)} placeholder="t" />
        </label>
        <label>
          Caption
          <Input controlSize="form" value={caption} onChange={(event) => setCaption(event.target.value)} />
        </label>
        <label>
          Label
          <Input controlSize="form" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="fig:name (optional)" />
        </label>
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <MotionButton
            type="button"
            className={buttonClassName({ variant: "primary" })}
            onClick={() => props.onInsert({ width, placement, caption, label: label.trim() || undefined })}
          >
            Insert
          </MotionButton>
        </div>
      </PopIn>
    </ModalDialog>
  );
}
