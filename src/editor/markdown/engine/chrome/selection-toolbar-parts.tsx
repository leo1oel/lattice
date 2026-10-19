/**
 * The selection toolbar's controls, shared by the visual editor's toolbar
 * (selection-toolbar.tsx, over Tiptap) and the Markdown source editor's
 * (canvas/markdown-source-toolbar.tsx, over CodeMirror): the block type menu,
 * the buttons and the divider (the items are selection-toolbar-items.ts).
 */
import { useRef, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../../../../components/ui/dropdown-menu";
import { selectionToolbarMenuClassName } from "../../../../components/ui/menu-surface";
import type { MarkdownBlockType } from "../../markdown-source-format";
import { TOOLBAR_BLOCK_TYPES } from "./selection-toolbar-items";
import "./selection-toolbar.css";

/**
 * The block type menu. It mounts in `container`, the toolbar's own layer:
 * each toolbar decides it lost focus by whether focus left that layer.
 */
export function BlockTypeMenu({ active, container, onSelect }: {
  active: MarkdownBlockType;
  container: HTMLElement;
  onSelect: (type: MarkdownBlockType) => void;
}) {
  const { t, i18n } = useLingui();
  const current = TOOLBAR_BLOCK_TYPES.find((type) => type.id === active) ?? TOOLBAR_BLOCK_TYPES[0]!;
  // The editor that had focus when the menu opened. CodeMirror takes focus
  // back as the choice applies, but the closing menu then drops it on the
  // body, and the writer's next keys went nowhere.
  const editorRef = useRef<Element | null>(null);
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) editorRef.current = document.activeElement; }}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="lx-md-toolbar-block" aria-label={t`Block type`} onMouseDown={(event) => event.preventDefault()}>
          <span>{i18n._(current.label)}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      {/* Clear of the toolbar, above it, so it reads as its own floating layer. */}
      <DropdownMenuContent container={container} align="start" sideOffset={8} className={selectionToolbarMenuClassName} onCloseAutoFocus={(event) => {
        event.preventDefault();
        const editor = editorRef.current;
        if (editor instanceof HTMLElement && editor.isConnected && document.activeElement === document.body) editor.focus({ preventScroll: true });
      }}>
        {TOOLBAR_BLOCK_TYPES.map((type) => (
          <BlockTypeItem key={type.id} separated={type.separated} active={type.id === current.id} onSelect={() => onSelect(type.id)}>
            {i18n._(type.label)}
          </BlockTypeItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BlockTypeItem({ separated, active, onSelect, children }: { separated?: boolean; active: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <>
      {separated && <DropdownMenuSeparator />}
      <DropdownMenuItem data-active={active || undefined} onSelect={onSelect}>
        <span className="lx-md-toolbar-check" aria-hidden="true">{active && <Check />}</span>
        {children}
      </DropdownMenuItem>
    </>
  );
}

/** A toolbar action; pressing it never takes focus or the selection from the editor. */
export function ToolbarButton({ label, pressed, onPress, children }: { label: string; pressed?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button type="button" className="lx-md-toolbar-button" aria-label={label} title={label} aria-pressed={pressed} onMouseDown={(event) => event.preventDefault()} onClick={onPress}>
      {children}
    </button>
  );
}

export function ToolbarDivider() {
  return <span className="lx-md-toolbar-divider" aria-hidden="true" />;
}
