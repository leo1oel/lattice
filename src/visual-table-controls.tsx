/**
 * Adapted from Inkeep Open Knowledge's TableCellHandles.tsx at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e (GPL-3.0-or-later).
 * Modified for Research Writer's GFM-only table model and UI primitives.
 */

import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Columns3, Rows3, Trash2 } from "lucide-react";

function selectionIsInCell(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const role = $from.node(depth).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
}

type ControlProps = {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

function Control({ label, disabled, onClick, children }: ControlProps) {
  return <button type="button" aria-label={label} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>;
}

/** Selection-relative controls remain mounted for a collapsed caret in a cell. */
export function VisualTableCellControls({ editor }: { editor: Editor }) {
  const [visible, setVisible] = useState(() => selectionIsInCell(editor));

  useEffect(() => {
    const update = () => setVisible(selectionIsInCell(editor));
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
    };
  }, [editor]);

  if (!visible || !editor.isEditable) return null;
  const chain = () => editor.chain().focus();

  return (
    <div className="visual-table-cell-controls" role="toolbar" aria-label="Table cell controls">
      <div role="group" aria-label="Columns">
        <Columns3 aria-hidden="true" />
        <Control label="Insert column left" disabled={!editor.can().addColumnBefore()} onClick={() => chain().addColumnBefore().run()}>+ Left</Control>
        <Control label="Insert column right" disabled={!editor.can().addColumnAfter()} onClick={() => chain().addColumnAfter().run()}>+ Right</Control>
        <Control label="Delete column" disabled={!editor.can().deleteColumn()} onClick={() => chain().deleteColumn().run()}><Trash2 aria-hidden="true" /> Column</Control>
      </div>
      <div role="group" aria-label="Rows">
        <Rows3 aria-hidden="true" />
        <Control label="Insert row above" disabled={!editor.can().addRowBefore()} onClick={() => chain().addRowBefore().run()}>+ Above</Control>
        <Control label="Insert row below" disabled={!editor.can().addRowAfter()} onClick={() => chain().addRowAfter().run()}>+ Below</Control>
        <Control label="Delete row" disabled={!editor.can().deleteRow()} onClick={() => chain().deleteRow().run()}><Trash2 aria-hidden="true" /> Row</Control>
      </div>
      <div role="group" aria-label="Table">
        <Control label="Delete table" disabled={!editor.can().deleteTable()} onClick={() => chain().deleteTable().run()}><Trash2 aria-hidden="true" /> Table</Control>
      </div>
    </div>
  );
}
