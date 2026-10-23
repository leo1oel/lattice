import { lazy, Suspense, useState } from "react";
import "./table-generator.css";
import { useLingui } from "@lingui/react/macro";
import { Grid3x3 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { CheckboxField } from "../../components/ui/checkbox-field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { LoadingAnnouncement } from "../../components/ui/loading-status";
import { PanelHeader } from "../../components/ui/panel-header";
import { SheetDialog } from "../../components/ui/sheet-dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { managedTableSource, newTableData, parseTableData, tableAtCursor, tableSource, validTableData, type TableData } from "./table-data";

const SourceDiff = lazy(() => import("../../history/file-diff-view").then((module) => ({ default: module.FileDiffView })));

export function TableGeneratorDialog(props: {
  onClose: () => void;
  target: () => { source: string; cursor: number; apply: (from: number, to: number, insert: string) => boolean } | null;
}) {
  const { t } = useLingui();
  const [target] = useState(props.target);
  const [block] = useState(() => target && tableAtCursor(target.source, target.cursor));
  const [data, setData] = useState<TableData>(() => block?.data ?? newTableData());
  const [paste, setPaste] = useState("");
  const [delimiter, setDelimiter] = useState("auto");
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const supported = target && (!block || block.data);
  const valid = validTableData(data);
  const update = (change: Partial<TableData>) => { setData({ ...data, ...change }); setReview(false); setError(""); };
  const resize = (rows: number, cols: number) => {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 20 || cols > 20) return;
    update({
      cells: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => data.cells[r]?.[c] ?? { text: "", latex: false })),
      align: Array.from({ length: cols }, (_, c) => data.align[c] ?? "l"),
    });
  };
  const importData = () => {
    const matrix = parseTableData(paste, delimiter === "tsv" || delimiter === "auto" && paste.includes("\t") ? "\t" : ",");
    if (!matrix) { setError(t`Use valid CSV or TSV with at most 20 rows and 20 columns.`); return; }
    update({ cells: matrix.map((row) => row.map((text) => ({ text, latex: false }))), align: matrix[0].map((_, c) => data.align[c] ?? "l") });
  };
  const apply = () => {
    if (!supported || !valid) return;
    const from = block?.from ?? target.cursor;
    // Keep markers on their own lines even when inserting in the middle of prose.
    const insert = `${!block && from > 0 && target.source[from - 1] !== "\n" ? "\n" : ""}${managedTableSource(data)}`;
    if (!target.apply(from, block?.to ?? from, insert)) {
      setError(t`The document changed. Close and reopen the table before applying.`);
      return;
    }
    props.onClose();
  };

  return (
    <SheetDialog className="table-generator" label={t`Table generator`} dirty onClose={props.onClose}>
      <PanelHeader className="drawer-header" icon={<Grid3x3 size={16} />} title={review ? t`Review source changes` : block ? t`Edit table` : t`Insert table`} onClose={props.onClose} />
      {!supported ? <p role="alert">{t`This table has source edits or unsupported structure. Continue editing it in the source editor.`}</p> : <>
        {!review && <>
        <label className="table-data-paste">{t`Paste data`}<Textarea autoFocus placeholder={t`Paste cells or CSV`} value={paste} onChange={(e) => setPaste(e.target.value)} /></label>
        <div className="table-generator-import">
          <Select value={delimiter} onValueChange={setDelimiter}>
            <SelectTrigger aria-label={t`Data format`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="auto">{t`Auto-detect`}</SelectItem><SelectItem value="csv">{t`CSV (comma)`}</SelectItem><SelectItem value="tsv">{t`TSV (tab)`}</SelectItem></SelectContent>
          </Select>
          <Button disabled={!paste} onClick={importData}>{t`Replace grid from data`}</Button>
        </div>
        <div className="table-generator-form">
          <label>{t`Rows`}<Input type="number" min={1} max={20} value={data.cells.length} onChange={(e) => resize(Number(e.target.value), data.align.length)} /></label>
          <label>{t`Columns`}<Input type="number" min={1} max={20} value={data.align.length} onChange={(e) => resize(data.cells.length, Number(e.target.value))} /></label>
          <label>{t`Decimal places`}<Input type="number" min={0} max={8} placeholder={t({ message: "Keep", context: "decimal places left blank" })} value={data.decimals ?? ""} onChange={(e) => update({ decimals: e.target.value === "" ? null : Number(e.target.value) })} /></label>
          <CheckboxField checked={data.booktabs} label={t`Booktabs rules`} onChange={(e) => update({ booktabs: e.target.checked })} />
          <CheckboxField checked={data.float} label={t`Wrap in table float`} onChange={(e) => update({ float: e.target.checked })} />
          {data.float && <>
            <label>{t`Caption`}<Input value={data.caption} onChange={(e) => update({ caption: e.target.value })} /></label>
            <label>{t`Label`}<Input value={data.label} onChange={(e) => update({ label: e.target.value })} /></label>
          </>}
        </div>
        {/* Lattice does not add the package, so a build would fail without it. */}
        {data.booktabs && <p className="table-generator-help">{t`Booktabs rules need the booktabs package`}</p>}
        <ScrollArea orientation="both" className="table-data-grid" fadeEdges={false}>
          <table aria-label={t`Table data`}>
            <thead><tr>{data.align.map((align, c) => <th key={c}>
              <Select value={align} onValueChange={(value) => update({ align: data.align.map((a, i) => i === c ? value as "l" | "c" | "r" : a) })}>
                <SelectTrigger aria-label={t`Column ${c + 1} alignment`}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="l">{t`Left`}</SelectItem><SelectItem value="c">{t`Center`}</SelectItem><SelectItem value="r">{t`Right`}</SelectItem></SelectContent>
              </Select>
            </th>)}</tr></thead>
            <tbody>{data.cells.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>
              <Input aria-label={t`Row ${r + 1}, column ${c + 1}`} value={cell.text} onChange={(e) => update({ cells: data.cells.map((cells, i) => i === r ? cells.map((item, j) => j === c ? { ...item, text: e.target.value } : item) : cells) })} />
              <CheckboxField checked={cell.latex} label={t`LaTeX`} aria-label={t`LaTeX for row ${r + 1}, column ${c + 1}`} onChange={(e) => update({ cells: data.cells.map((cells, i) => i === r ? cells.map((item, j) => j === c ? { ...item, latex: e.target.checked } : item) : cells) })} />
            </td>)}</tr>)}</tbody>
          </table>
        </ScrollArea>
        </>}
        {!valid && <p role="alert">{t`Check decimal places (0–8), label (letters, digits, colon, dot, dash or underscore), and LaTeX cells (no table structure, line breaks, & or %).`}</p>}
        {review && valid && <section aria-label={t`Source changes`}>
          <Suspense fallback={<LoadingAnnouncement message={t`Rendering diff…`} />}>
            <SourceDiff change={{ path: "table.tex", before: block?.data ? tableSource(block.data) : "", after: tableSource(data) }} />
          </Suspense>
        </section>}
      </>}
      {error && <p role="alert">{error}</p>}
      <div className="table-generator-actions">
        <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
        {review && <Button onClick={() => setReview(false)}>{t`Back`}</Button>}
        {supported && (review ? <Button variant="primary" disabled={!valid} onClick={apply}>{block ? t`Update table` : t`Insert table`}</Button> : <Button variant="primary" disabled={!valid} onClick={() => setReview(true)}>{t`Review source changes`}</Button>)}
      </div>
    </SheetDialog>
  );
}
