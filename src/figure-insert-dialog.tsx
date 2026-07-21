import { useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { DEFAULT_FIGURE_OPTIONS, type FigureInsertOptions } from "./figure-insertion";

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
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal figure-insert-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="Insert figure">
        <div className="modal-icon"><ImagePlus size={19} /></div>
        <div className="drawer-header" style={{ padding: 0, border: 0, marginBottom: 8 }}>
          <div><span>Insert figure</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p>{props.paths.length === 1 ? props.paths[0] : `${props.paths.length} figures`}</p>
        <label>
          Width
          <input value={width} onChange={(event) => setWidth(event.target.value)} placeholder="0.8\linewidth" />
        </label>
        <label>
          Placement
          <input value={placement} onChange={(event) => setPlacement(event.target.value)} placeholder="t" />
        </label>
        <label>
          Caption
          <input value={caption} onChange={(event) => setCaption(event.target.value)} />
        </label>
        <label>
          Label
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="fig:name (optional)" />
        </label>
        <div className="modal-actions">
          <button type="button" className="text-button" onClick={props.onClose}>Cancel</button>
          <button
            type="button"
            className="primary-button"
            onClick={() => props.onInsert({ width, placement, caption, label: label.trim() || undefined })}
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
