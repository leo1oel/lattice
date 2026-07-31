import { useState } from "react";
import { Grid3x3 } from "lucide-react";
import { Button } from "./components/ui/button";
import { CheckboxField } from "./components/ui/checkbox-field";
import { Input } from "./components/ui/input";
import { PanelHeader } from "./components/ui/panel-header";
import { buildTabularSnippet, clampTableSize, type TableGeneratorOptions } from "./table-generator";

export function TableGeneratorDialog(props: {
  open: boolean;
  onClose: () => void;
  onInsert: (insert: string, cursorOffset: number) => void;
}) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [booktabs, setBooktabs] = useState(true);
  const [float, setFloat] = useState(true);
  const [caption, setCaption] = useState("Caption");
  const [label, setLabel] = useState("tab:name");

  if (!props.open) return null;

  const options: TableGeneratorOptions = {
    rows: clampTableSize(rows),
    cols: clampTableSize(cols),
    booktabs,
    float,
    caption,
    label,
  };
  const preview = buildTabularSnippet(options);

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="table-generator" onMouseDown={(event) => event.stopPropagation()} aria-label="Table generator">
        <PanelHeader
          className="drawer-header"
          icon={<Grid3x3 size={16} />}
          title="Insert table"
          onClose={props.onClose}
        />
        <div className="table-generator-form">
          <label>
            Rows
            <Input
              type="number"
              min={1}
              max={20}
              value={rows}
              onChange={(event) => setRows(Number(event.target.value))}
            />
          </label>
          <label>
            Columns
            <Input
              type="number"
              min={1}
              max={20}
              value={cols}
              onChange={(event) => setCols(Number(event.target.value))}
            />
          </label>
          <CheckboxField
            checked={booktabs}
            label="Booktabs rules"
            onChange={(event) => setBooktabs(event.target.checked)}
          />
          <CheckboxField
            checked={float}
            label="Wrap in table float"
            onChange={(event) => setFloat(event.target.checked)}
          />
          {float && (
            <>
              <label>
                Caption
                <Input value={caption} onChange={(event) => setCaption(event.target.value)} />
              </label>
              <label>
                Label
                <Input value={label} onChange={(event) => setLabel(event.target.value)} />
              </label>
            </>
          )}
        </div>
        <pre className="table-generator-preview" aria-label="Table preview">{preview.insert}</pre>
        <div className="table-generator-actions">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              props.onInsert(preview.insert, preview.cursorOffset);
              props.onClose();
            }}
          >
            Insert table
          </Button>
        </div>
      </aside>
    </div>
  );
}
