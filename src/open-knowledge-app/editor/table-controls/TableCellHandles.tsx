/**
 * TableCellHandles — per-column / per-row dropdown handles for the active cell.
 *
 * When the selection is inside a table cell, two handles appear: one above the
 * cell's column and one to the left of its row. Each opens a dropdown scoped to
 * that column/row (insert before/after, delete, delete table; plus a header
 * toggle on the first column/row only). Replaces the old single bubble toolbar.
 *
 * Cell geometry is resolved from ProseMirror's `TableMap`, then mapped back to
 * DOM anchors. This matters once the visual editor restores HTML/LaTeX spans:
 * a DOM `cellIndex` is only a physical child index and no longer identifies a
 * logical markdown column in the presence of colspan/rowspan.
 *
 * Positioning uses floating-ui `strategy: 'fixed'` + `autoUpdate`; the body
 * portal avoids transformed editor ancestors becoming the containing block.
 *
 * The handles portal to `document.body` and use fixed viewport coordinates.
 * Keeping them outside the editor scrollport is required because a row handle
 * straddles the table's left edge and would otherwise be clipped in half.
 *
 * Commands are the stock tiptap table commands, run selection-relative (the
 * active cell is the selection, so `addColumnAfter` etc. target the right
 * column/row).
 *
 * The layer exists only while the editor selection is inside a table cell.
 */

import { autoUpdate, computePosition, hide, offset } from '@floating-ui/dom';
import type { MessageDescriptor } from '@ok-app/shims/lingui-core';
import { msg } from '@ok-app/shims/lingui-core-macro';
import { useLingui } from '@ok-app/shims/lingui-react-macro';
import { TableMap } from '@tiptap/pm/tables';
import type { Editor } from '@tiptap/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns3,
  Ellipsis,
  EllipsisVertical,
  Grid2x2X,
  type LucideIcon,
  TableProperties,
  Trash2,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@ok-app/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ok-app/components/ui/dropdown-menu';
import { getFindReplaceState } from '../find-replace/tiptap-find-replace-extension';
import { handleAnchorCellPos, selectTableAxis } from './table-axis-selection';
import { useTableDragReorder } from './useTableDragReorder';

type Axis = 'column' | 'row';

interface ActiveCell {
  /** Top cell of the active column — anchor for the column handle. */
  columnAnchor: HTMLTableCellElement;
  /** Left cell of the active row — anchor for the row handle. */
  rowAnchor: HTMLTableCellElement;
  isFirstColumn: boolean;
  isFirstRow: boolean;
  /** The legacy reorder transaction rebuilds a rectangular table. Keep the
   * handles and their menus available for spanned tables, but don't expose a
   * drag gesture that could corrupt their logical grid. */
  canReorder: boolean;
}

interface MenuItem {
  /** Stable React key — the label is a descriptor and the resolved text moves with the locale. */
  id: string;
  /**
   * Deferred message. The item lists are built outside a component, so the
   * label has to stay a descriptor and resolve at render; a `t` call here
   * would freeze the menu in whatever language was active at module load.
   */
  label: MessageDescriptor;
  icon: LucideIcon;
  run: (editor: Editor) => void;
  /** Render a separator above this item (groups destructive actions). */
  separatorBefore?: boolean;
}

function columnItems(showHeaderToggle: boolean): MenuItem[] {
  return [
    ...(showHeaderToggle
      ? [
          {
            id: 'toggle-header-column',
            label: msg`Toggle header column`,
            icon: Columns3,
            run: (e: Editor) => e.chain().focus().toggleHeaderColumn().run(),
          },
        ]
      : []),
    {
      id: 'insert-column-left',
      label: msg`Insert column left`,
      icon: ArrowLeft,
      run: (e) => e.chain().focus().addColumnBefore().run(),
    },
    {
      id: 'insert-column-right',
      label: msg`Insert column right`,
      icon: ArrowRight,
      run: (e) => e.chain().focus().addColumnAfter().run(),
    },
    {
      id: 'delete-column',
      label: msg`Delete column`,
      icon: Trash2,
      separatorBefore: true,
      run: (e) => e.chain().focus().deleteColumn().run(),
    },
    {
      id: 'delete-table',
      label: msg`Delete table`,
      icon: Grid2x2X,
      run: (e) => e.chain().focus().deleteTable().run(),
    },
  ];
}

function rowItems(showHeaderToggle: boolean): MenuItem[] {
  return [
    ...(showHeaderToggle
      ? [
          {
            id: 'toggle-header-row',
            label: msg`Toggle header row`,
            icon: TableProperties,
            run: (e: Editor) => e.chain().focus().toggleHeaderRow().run(),
          },
        ]
      : []),
    {
      id: 'insert-row-above',
      label: msg`Insert row above`,
      icon: ArrowUp,
      run: (e) => e.chain().focus().addRowBefore().run(),
    },
    {
      id: 'insert-row-below',
      label: msg`Insert row below`,
      icon: ArrowDown,
      run: (e) => e.chain().focus().addRowAfter().run(),
    },
    {
      id: 'delete-row',
      label: msg`Delete row`,
      icon: Trash2,
      separatorBefore: true,
      run: (e) => e.chain().focus().deleteRow().run(),
    },
    {
      id: 'delete-table',
      label: msg`Delete table`,
      icon: Grid2x2X,
      run: (e) => e.chain().focus().deleteTable().run(),
    },
  ];
}

function computeActiveCell(editor: Editor): ActiveCell | null {
  if (!editor.isEditable) return null;
  // Stand down while find-replace owns the selection.
  if (getFindReplaceState(editor.state).query) return null;

  const { state, view } = editor;
  // A table selection anchors both handles to its top-left cell; `$from` is the
  // far corner of a selected axis and would fling the sibling handle across the
  // table. Everything else walks up from the caret as before.
  let cellPos = handleAnchorCellPos(state.selection) ?? -1;
  if (cellPos < 0) {
    const $from = state.selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
      const role = $from.node(depth).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') {
        cellPos = $from.before(depth);
        break;
      }
    }
  }
  if (cellPos < 0) return null;

  const cellDOM = view.nodeDOM(cellPos);
  if (!(cellDOM instanceof HTMLTableCellElement)) return null;
  // Guard that the cell is actually in a mounted editor view (not a stale
  // node from a previous doc); the handles themselves render in the React
  // tree, so we don't need the editor content node as a portal target.
  const inEditor = cellDOM.closest('.ProseMirror');
  if (!inEditor) return null;

  // A cell position resolves in its row. Walk to the containing table, then
  // ask TableMap for the selected cell's logical rectangle and for the origin
  // cells covering that column at the top and that row at the left. Either
  // anchor may itself span several logical cells, which is exactly the surface
  // ProseMirror must select when a partial axis would cut through a merge.
  const $cell = state.doc.resolve(cellPos);
  let tableDepth = -1;
  for (let depth = $cell.depth; depth > 0; depth--) {
    if ($cell.node(depth).type.spec.tableRole === 'table') {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0) return null;
  const table = $cell.node(tableDepth);
  const tableStart = $cell.start(tableDepth);
  let map: TableMap;
  let rect: { left: number; top: number };
  try {
    map = TableMap.get(table);
    rect = map.findCell(cellPos - tableStart);
  } catch {
    // A concurrent edit can briefly leave a stale selection against a table
    // being repaired by prosemirror-tables. The next update recomputes it.
    return null;
  }
  const columnOffset = map.map[rect.left];
  const rowOffset = map.map[rect.top * map.width];
  if (columnOffset === undefined || rowOffset === undefined) return null;
  const columnAnchor = view.nodeDOM(tableStart + columnOffset);
  const rowAnchor = view.nodeDOM(tableStart + rowOffset);
  if (
    !(columnAnchor instanceof HTMLTableCellElement) ||
    !(rowAnchor instanceof HTMLTableCellElement)
  ) {
    return null;
  }

  let canReorder = true;
  table.forEach((row) => {
    row.forEach((cell) => {
      if (Number(cell.attrs.colspan ?? 1) > 1 || Number(cell.attrs.rowspan ?? 1) > 1) {
        canReorder = false;
      }
    });
  });

  return {
    columnAnchor,
    rowAnchor,
    isFirstColumn: rect.left === 0,
    isFirstRow: rect.top === 0,
    canReorder,
  };
}

function CellHandle({
  editor,
  anchor,
  axis,
  items,
  canReorder,
}: {
  editor: Editor;
  anchor: HTMLTableCellElement;
  axis: Axis;
  items: MenuItem[];
  canReorder: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Reading the macro `t` here is also what subscribes this component to
  // Lingui's change event: `I18nProvider` re-renders context consumers only,
  // so without a hook call the menu would keep the language it mounted in.
  const { t } = useLingui();
  // Controlled Radix open state — the drag hook coordinates against it so
  // a pending drag never flashes the menu open. The hook's pointerup calls
  // onClickGesture when the gesture stayed under the drag threshold, and
  // we translate that into `setOpen(true)`.
  const [open, setOpen] = useState(false);
  const drag = useTableDragReorder({
    editor,
    axis,
    anchor,
    enabled: canReorder,
    // Select before opening: the menu's items all act on this row / column, so
    // the selection is what the menu is ABOUT — and it leaves the axis
    // highlighted for the selection-scoped surfaces (copy, comment) that the
    // handle was previously invisible to.
    onClickGesture: () => {
      selectTableAxis(editor, anchor, axis);
      setOpen(true);
    },
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const placement = axis === 'column' ? 'top' : 'left';
    // Negative offset pulls the handle onto the table edge rather than floating
    // outside it — our layout has no gutter, so a positive gap would push it
    // into adjacent content (the block above / content beside the table). The
    // column sits lower (more onto the table) than the row: a horizontal pill
    // above the edge reads as more "floating" than a vertical pill beside it,
    // so it needs more overlap to look equally attached.
    const overlap = axis === 'column' ? -14 : -6;
    const update = () => {
      void computePosition(anchor, el, {
        strategy: 'fixed',
        placement,
        middleware: [offset(overlap), hide()],
      })
        .then(({ x, y, middlewareData }) => {
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          el.style.opacity = '1';
          el.style.visibility = middlewareData.hide?.referenceHidden ? 'hidden' : 'visible';
        })
        // Anchor cell can be detached by a remote edit before this resolves;
        // the next autoUpdate tick re-positions, so swallow the rejection.
        .catch(() => {});
    };
    return autoUpdate(anchor, el, update);
  }, [anchor, axis]);

  const HandleIcon = axis === 'column' ? Ellipsis : EllipsisVertical;

  return (
    <>
      <div
        ref={ref}
        data-testid="table-cell-handle"
        className="absolute left-0 top-0 z-10 opacity-0"
      >
        <DropdownMenu
          open={open}
          onOpenChange={(next) => {
            if (!drag.shouldAllowOpen(next)) return;
            // When drag is unavailable (merged table), Radix owns the normal
            // pointerdown open path instead of the hook's click fallback.
            if (next) selectTableAxis(editor, anchor, axis);
            setOpen(next);
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              onPointerDown={drag.onPointerDown}
              // The transparent `::before` (-inset-6px) expands the click target
              // to ~24px (WCAG 2.5.8) without enlarging the visible 12px pill.
              // `cursor-grab` telegraphs the drag affordance for rectangular
              // tables; merged tables use a normal menu cursor because their
              // reorder gesture is deliberately disabled.
              className={
                axis === 'column'
                  ? `h-3 w-7 rounded-full p-0 text-gray-700 dark:text-muted-foreground bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 hover:text-foreground dark:hover:bg-gray-600 dark:hover:text-gray-100 relative ${canReorder ? 'cursor-grab' : 'cursor-default'} before:absolute before:-inset-[6px] before:content-[""]`
                  : `h-7 w-3 rounded-full p-0 text-gray-700 dark:text-muted-foreground bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 hover:text-foreground dark:hover:bg-gray-600 dark:hover:text-gray-100 relative ${canReorder ? 'cursor-grab' : 'cursor-default'} before:absolute before:-inset-[6px] before:content-[""]`
              }
              aria-label={axis === 'column' ? t`Column options` : t`Row options`}
            >
              <HandleIcon className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={axis === 'column' ? 'center' : 'start'}
            side={axis === 'column' ? 'bottom' : 'right'}
            // Override the shadcn default `w-(--radix-…-trigger-width)`: the trigger
            // is a tiny handle, so width-to-trigger collapses the menu and wraps
            // labels. Size to content instead, with a comfortable floor.
            className="w-auto min-w-44 whitespace-nowrap"
          >
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => item.run(editor)}>
                  <item.icon aria-hidden />
                  {t(item.label)}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {drag.indicator && (
        // Fixed-position drop indicator. Escapes the transformed-ancestor
        // trap that `strategy: 'absolute'` was chosen to avoid — we compute
        // client coordinates directly from the table's DOMRect, so fixed
        // positioning is correct here (unlike the handles, whose autoUpdate
        // tracks scroll via floating-ui). The `pointerEvents: 'none'` keeps
        // the indicator from intercepting the ongoing gesture.
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 bg-primary"
          style={{
            left: drag.indicator.rect.left,
            top: drag.indicator.rect.top,
            width: drag.indicator.rect.width,
            height: drag.indicator.rect.height,
          }}
        />
      )}
    </>
  );
}

export function TableCellHandles({ editor }: { editor: Editor }) {
  const [active, setActive] = useState<ActiveCell | null>(null);

  useEffect(() => {
    // Bail when the active cell is unchanged (same column/row anchors) so a
    // keystroke inside a table doesn't churn a fresh object and re-render the
    // two dropdowns. Anchors are stable DOM elements per cell.
    const update = () =>
      setActive((prev) => {
        const next = computeActiveCell(editor);
        if (
          prev &&
          next &&
          prev.columnAnchor === next.columnAnchor &&
          prev.rowAnchor === next.rowAnchor &&
          prev.isFirstColumn === next.isFirstColumn &&
          prev.isFirstRow === next.isFirstRow &&
          prev.canReorder === next.canReorder
        ) {
          return prev;
        }
        return next;
      });
    update();
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('update', update);
    };
  }, [editor]);

  if (!active || typeof document === 'undefined') return null;

  // Body is safe from TipTap's Activity recycle and from editor/table clipping.
  return createPortal(
    <div className="ok-table-cell-handle-layer is-visible">
      <CellHandle
        editor={editor}
        anchor={active.columnAnchor}
        axis="column"
        items={columnItems(active.isFirstColumn)}
        canReorder={active.canReorder}
      />
      <CellHandle
        editor={editor}
        anchor={active.rowAnchor}
        axis="row"
        items={rowItems(active.isFirstRow)}
        canReorder={active.canReorder}
      />
    </div>,
    document.body,
  );
}
