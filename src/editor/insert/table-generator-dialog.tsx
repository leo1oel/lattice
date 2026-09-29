import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Grid3x3 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { CheckboxField } from "../../components/ui/checkbox-field";
import { Input } from "../../components/ui/input";
import { PanelHeader } from "../../components/ui/panel-header";
import { buildTabularSnippet } from "./table-generator";

export function TableGeneratorDialog(props: {
  open: boolean;
  onClose: () => void;
  onInsert: (insert: string, cursorOffset: number) => void;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [booktabs, setBooktabs] = useState(true);
  const [float, setFloat] = useState(true);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- placeholder caption written into the LaTeX source
  const [caption, setCaption] = useState("Caption");
  const [label, setLabel] = useState("tab:name");

  if (!props.open) return null;

  const preview = buildTabularSnippet({ rows, cols, booktabs, float, caption, label });

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="table-generator" onMouseDown={(event) => event.stopPropagation()} aria-label={t`Table generator`}>
        <PanelHeader
          className="drawer-header"
          icon={<Grid3x3 size={16} />}
          title={t`Insert table`}
          onClose={props.onClose}
        />
        <div className="table-generator-form">
          <label>
            {t`Rows`}
            <Input type="number" min={1} max={20} value={rows} onChange={(event) => setRows(Number(event.target.value))} />
          </label>
          <label>
            {t`Columns`}
            <Input type="number" min={1} max={20} value={cols} onChange={(event) => setCols(Number(event.target.value))} />
          </label>
          <CheckboxField checked={booktabs} label={t`Booktabs rules`} onChange={(event) => setBooktabs(event.target.checked)} />
          <CheckboxField checked={float} label={t`Wrap in table float`} onChange={(event) => setFloat(event.target.checked)} />
          {float && (
            <>
              <label>
                {t`Caption`}
                <Input value={caption} onChange={(event) => setCaption(event.target.value)} />
              </label>
              <label>
                {t`Label`}
                <Input value={label} onChange={(event) => setLabel(event.target.value)} />
              </label>
            </>
          )}
        </div>
        <pre className="table-generator-preview" aria-label={t`Table preview`}>{preview.insert}</pre>
        <div className="table-generator-actions">
          <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
          <Button
            variant="primary"
            onClick={() => {
              props.onInsert(preview.insert, preview.cursorOffset);
              props.onClose();
            }}
          >
            {t`Insert table`}
          </Button>
        </div>
      </aside>
    </div>
  );
}
