import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, Ellipsis, ZoomIn, ZoomOut } from "lucide-react";
import { Tip } from "../components/icon-tip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { PDF_MAX_SCALE, PDF_MIN_SCALE } from "./pdf-viewer-utils";

export type MenuAction = { label: string; icon: ReactNode; disabled?: boolean; checked?: boolean; run: () => void };

/**
 * The control that takes focus from a menu whose trigger a wide toolbar hid:
 * the first enabled one the menu stood in for, in its zoom-first order (the
 * zoom steps lead the menu), or the preview itself when all are disabled.
 */
function nextVisibleControl(trigger: HTMLElement): HTMLElement | null {
  const toolbar = trigger.closest(".pdf-toolbar");
  const candidates = [".pdf-zoom-controls button.pdf-overflow", ".pdf-history-controls button"]
    .flatMap((selector) => [...toolbar?.querySelectorAll<HTMLElement>(selector) ?? []]);
  const control = candidates.find((candidate) => !candidate.matches(":disabled") && candidate.getClientRects().length > 0);
  return control ?? trigger.closest<HTMLElement>(".pdf-preview");
}

/**
 * A narrow toolbar's home for what it sets aside (pdf-viewer.css): the zoom
 * steps and value, the fit mode not in use, location history and saving. It
 * is only reachable while the toolbar is narrow; a wide one shows each control.
 *
 * Widening the panel or window past the breakpoint with the menu open hides
 * its trigger, and the portaled menu would follow that empty box to the
 * window's corner. So while open, the toolbar's frame (its size container,
 * which a divider drag already resizes) is watched, and the menu closes once
 * the trigger is gone, handing focus to a control it stood in for.
 */
export function PdfOverflowMenu({ open, onOpenChange, scale, stepZoom, onEnterZoom, groups }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only read while open; pass a constant otherwise, so zooming never re-renders the closed menu. */
  scale: number;
  stepZoom: (direction: 1 | -1) => void;
  /** Close the menu and type a percentage into the toolbar's own zoom field. */
  onEnterZoom: () => void;
  groups: MenuAction[][];
}) {
  const { t } = useLingui();
  const zoomEntryRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Where focus goes when the menu closes because its trigger was hidden: null
  // to leave it be (it was not in the menu), else the toolbar control to take it.
  const strandedFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  useEffect(() => {
    const trigger = triggerRef.current;
    const frame = trigger?.closest(".pdf-toolbar-frame");
    if (!open || !trigger || !frame) return;
    const observer = new ResizeObserver(() => {
      if (trigger.getClientRects().length) return;
      const hadFocus = Boolean(contentRef.current?.contains(document.activeElement));
      strandedFocusRef.current = hadFocus ? nextVisibleControl(trigger) : null;
      onOpenChange(false);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [open, onOpenChange]);
  // Stepping keeps the menu open, so a reader can click until the page is right.
  const step = (direction: 1 | -1) => (event: Event) => {
    event.preventDefault();
    stepZoom(direction);
  };
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <Tip label={t`More PDF actions`}>
        <DropdownMenuTrigger asChild>
          <button ref={triggerRef} type="button" className="pdf-overflow-trigger"><Ellipsis size={14} /></button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        ref={contentRef}
        align="end"
        sideOffset={6}
        className="pdf-overflow-menu min-w-[13.5rem]"
        onCloseAutoFocus={(event) => {
          const stranded = strandedFocusRef.current;
          if (stranded !== undefined) {
            strandedFocusRef.current = undefined;
            zoomEntryRef.current = false;
            event.preventDefault();
            stranded?.focus();
            return;
          }
          if (!zoomEntryRef.current) return;
          zoomEntryRef.current = false;
          event.preventDefault();
          onEnterZoom();
        }}
      >
        <div className="pdf-overflow-zoom" role="group" aria-label={t`Zoom`}>
          <span className="pdf-overflow-zoom-label" aria-hidden="true">{t`Zoom`}</span>
          <DropdownMenuItem aria-label={t`Zoom out`} disabled={scale <= PDF_MIN_SCALE} onSelect={step(-1)}>
            <ZoomOut />
          </DropdownMenuItem>
          <DropdownMenuItem
            className="pdf-overflow-zoom-value"
            aria-label={t`Enter a zoom percentage`}
            onSelect={() => { zoomEntryRef.current = true; }}
          >
            {Math.round(scale * 100)}%
          </DropdownMenuItem>
          <DropdownMenuItem aria-label={t`Zoom in`} disabled={scale >= PDF_MAX_SCALE} onSelect={step(1)}>
            <ZoomIn />
          </DropdownMenuItem>
        </div>
        {groups.filter((group) => group.length).map((group, index) => (
          <Fragment key={index}>
            <DropdownMenuSeparator />
            {group.map((action) => (
              <DropdownMenuItem
                key={action.label}
                disabled={action.disabled}
                onSelect={action.run}
                {...(action.checked === undefined ? {} : { role: "menuitemcheckbox", "aria-checked": action.checked })}
              >
                {action.icon}
                <span className="flex-1">{action.label}</span>
                {action.checked && <Check size={14} className="pdf-overflow-check" />}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
