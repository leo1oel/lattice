/**
 * Titlebar controls for the Trellis workspace: a Panels menu that reopens any
 * panel or tool, switches the workspace or preset and resets the layout, the
 * layout switch (the named workspaces, then Writing and Reading; see
 * trellis-workspace-switch), one toggle each for Project, Papers and the
 * Agent, maximize/restore and reset, and a chip per hidden panel. The PDF
 * comes up from each .tex panel's Build button (and the Panels menu).
 * Eager but light: it drives the workspace only through the controller.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Bot, Check, FileText, FolderTree, LayoutPanelLeft, Library, Maximize2, Minimize2, RotateCcw,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Tip } from "../components/icon-tip";
import {
  TOOL_KINDS, useCurrentWorkspace, useWorkspaces, type TrellisController, type TrellisPanelState, type TrellisSingleton,
} from "./trellis-controller";
import { PANEL_TITLES, spaceMixedScript } from "./trellis-titles";
import { PANEL_ICONS, PRESETS } from "./trellis-icons";
import { LayoutSwitch } from "./trellis-workspace-switch";
import { workspaceShortcut } from "./trellis-workspaces";

const CORE_PANELS = [
  { kind: "project", icon: <FolderTree size={14} /> },
  { kind: "papers", icon: <Library size={14} /> },
  { kind: "agent", icon: <Bot size={14} /> },
  { kind: "pdf", icon: <FileText size={14} /> },
] as const satisfies ReadonlyArray<{ kind: TrellisSingleton; icon: unknown }>;
/** The panels with a titlebar toggle; the PDF follows the Build buttons instead. */
const TOGGLED_PANELS = CORE_PANELS.filter((panel) => panel.kind !== "pdf");

/**
 * Each core panel's state, re-read whenever panels open, close, hide or show
 * and when the workspace attaches (panels announce themselves before it does).
 * The snapshot is a string so an unchanged answer does not re-render.
 */
function usePanelStates(controller: TrellisController) {
  const subscribe = useCallback((listener: () => void) => {
    const offUi = controller.ui.subscribe(listener);
    const offWorkspace = controller.subscribeWorkspace(listener);
    return () => { offUi(); offWorkspace(); };
  }, [controller]);
  const snapshot = useSyncExternalStore(subscribe, () => CORE_PANELS.map(({ kind }) => controller.panelState(kind)).join(","));
  return useMemo(() => {
    const states = snapshot.split(",") as TrellisPanelState[];
    return (kind: TrellisSingleton) => states[CORE_PANELS.findIndex((panel) => panel.kind === kind)] ?? "absent";
  }, [snapshot]);
}

/**
 * Whether the layout presets must drop their labels: only when the controls,
 * labelled, would not fit the room the titlebar has (what the window leaves
 * beside the canvas tools), so the answer follows the window, those tools and
 * the language's label lengths rather than a fixed window width. The hidden
 * panels' chips count as content to fit, since they shrink before anything
 * else would overflow and a restore chip clipped to nothing is lost: both
 * the row's own overflow and each chip squeezed below its own width cap.
 *
 * Labelled, the controls are measured against the room; compact, the room is
 * compared with what they needed labelled, so the labels come back only where
 * they fit and the switch cannot oscillate. `content` names what changes that
 * need (the language, the chips), which re-measures it labelled.
 */
function useCompactPresets(barRef: RefObject<HTMLDivElement | null>, chipsRef: RefObject<HTMLDivElement | null>, content: string) {
  // A fit belongs to the content it was measured with: new content starts
  // labelled, and is measured that way before it paints (a layout effect).
  const [fit, setFit] = useState({ content, labelledNeed: 0 });
  const compact = fit.content === content && fit.labelledNeed > 0;
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const room = bar.clientWidth;
      if (!compact) {
        const need = controlsDemand(bar, chipsRef.current);
        if (need > room + 0.5) setFit({ content, labelledNeed: need });
      } else if (room >= fit.labelledNeed) {
        setFit({ content, labelledNeed: 0 });
      }
    };
    // The bar's own size is the room; its controls' sizes change with what
    // they hold (a web font arriving, a chip's title) without changing it.
    // An observer reports each target once on observe, which measures now.
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    for (const control of bar.children) observer.observe(control);
    return () => observer.disconnect();
  }, [barRef, chipsRef, compact, content, fit.labelledNeed]);
  return compact;
}

/**
 * How wide the titlebar's controls ask to be, as laid out now. The bar is a
 * flex row as wide as its room, so its scrollWidth never reads less than that
 * room however empty the row is: the controls use up to where the last of
 * them ends, or past the room when they overflow it. A restore chip ends in
 * an ellipsis at its own width cap whatever the room, so only what the row
 * squeezed it below that cap (or the chips' row clipped) is room missing.
 */
function controlsDemand(bar: HTMLElement, chips: HTMLElement | null): number {
  const box = bar.getBoundingClientRect();
  let end = box.left;
  for (const control of bar.children) {
    const rect = control.getBoundingClientRect();
    if (rect.width > 0) end = Math.max(end, rect.right);
  }
  const contentEnd = box.right - bar.clientLeft - (Number.parseFloat(getComputedStyle(bar).paddingRight) || 0);
  let need = bar.scrollWidth - Math.max(0, contentEnd - end);
  if (!chips) return need;
  need += Math.max(0, chips.scrollWidth - chips.clientWidth);
  for (const chip of chips.children) {
    if (!(chip instanceof HTMLElement)) continue;
    const full = chip.scrollWidth + chip.offsetWidth - chip.clientWidth;
    const cap = Number.parseFloat(getComputedStyle(chip).maxWidth);
    const squeezed = Math.min(full, Number.isNaN(cap) ? full : cap) - chip.getBoundingClientRect().width;
    // scrollWidth is whole pixels: a fraction short is rounding, not a cut title.
    if (squeezed >= 1) need += squeezed;
  }
  return need;
}

/** Memoized: App re-renders per keystroke and these controls only follow the workspace. */
export const TrellisTitlebar = memo(function TrellisTitlebar({ controller }: { controller: TrellisController }) {
  const { t, i18n } = useLingui();
  const hidden = useSyncExternalStore(controller.ui.subscribe, () => controller.ui.get().hidden);
  const framed = useSyncExternalStore(controller.ui.subscribe, () => controller.ui.get().framed);
  const preset = useSyncExternalStore(controller.ui.subscribe, () => controller.ui.get().preset);
  const workspaces = useWorkspaces(controller);
  const workspace = useCurrentWorkspace(controller);
  const panelState = usePanelStates(controller);
  const ws = () => controller.ws;
  const title = (kind: TrellisSingleton) => i18n._(PANEL_TITLES[kind]);
  const presetLabels = { writing: t`Writing`, reading: t`Reading` };
  const barRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  // The workspaces' names are content to fit as much as the chips are.
  const content = [i18n.locale, ...workspaces.map((entry) => entry.name), "", ...hidden.map((entry) => entry.title)].join("\n");
  const compact = useCompactPresets(barRef, chipsRef, content);
  // One command in two places: the inline button and, once that is shed, the
  // Panels menu, so the menu never offers Maximize while it would restore.
  const frameAction = framed
    ? { label: t`Restore the layout`, tip: t`Restore the layout · ⌘⇧↩`, Icon: Minimize2, run: () => ws()?.navigation.frame("all") }
    : { label: t`Maximize focused panel`, tip: t`Maximize panel · ⌘⇧↩`, Icon: Maximize2, run: () => ws()?.navigation.toggle() };
  // Showing a panel or tool moves keyboard focus into it (Trellis focuses the
  // panel a frame later, a drawer its own field), so the closing menu must not
  // pull focus back to its trigger. Every other close - Escape, a layout
  // command - returns focus to Panels, where the keyboard left off.
  const handsOffFocusRef = useRef(false);
  const showPanel = (kind: TrellisSingleton) => {
    handsOffFocusRef.current = true;
    controller.showPanel(kind);
  };
  return (
    <div ref={barRef} className="trellis-titlebar" data-compact={compact || undefined}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className="trellis-titlebar-menu" aria-label={t`Panels`} data-trellis-panels-menu="">
            <LayoutPanelLeft size={14} />
            <span>{t`Panels`}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="min-w-[14rem]"
          onCloseAutoFocus={(event) => {
            if (!handsOffFocusRef.current) return;
            handsOffFocusRef.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuLabel>{t`Panels`}</DropdownMenuLabel>
          {CORE_PANELS.map(({ kind, icon }) => (
            <DropdownMenuItem key={kind} onSelect={() => showPanel(kind)}>
              {icon}
              <span className="flex-1">{title(kind)}</span>
              {panelState(kind) !== "shown" && <span className="trellis-menu-state">{panelState(kind) === "hidden" ? t`Hidden` : t`Closed`}</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t`Tools`}</DropdownMenuLabel>
          {TOOL_KINDS.map((kind) => (
            <DropdownMenuItem key={kind} onSelect={() => showPanel(kind)}>{PANEL_ICONS[kind]}{title(kind)}</DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t`Layout`}</DropdownMenuLabel>
          {workspaces.map((entry, index) => {
            const chosen = !preset && entry.id === workspace;
            return (
              <DropdownMenuItem key={entry.id} role="menuitemradio" aria-checked={chosen} onSelect={() => controller.switchWorkspace(entry.id)}>
                <span className="trellis-menu-check">{chosen && <Check size={14} />}</span>
                <span className="flex-1 truncate">{entry.name}</span>
                {workspaceShortcut(index) && <span className="trellis-menu-shortcut">{workspaceShortcut(index)}</span>}
              </DropdownMenuItem>
            );
          })}
          {PRESETS.map(({ value, icon: Icon }) => (
            <DropdownMenuItem key={value} role="menuitemradio" aria-checked={preset === value} onSelect={() => controller.setPreset(value)}>
              <Icon size={14} />
              <span className="flex-1">{presetLabels[value]}</span>
              {preset === value && <Check size={14} className="trellis-menu-state" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={frameAction.run}>
            <frameAction.Icon size={14} />
            <span className="flex-1">{frameAction.label}</span>
            <span className="trellis-menu-shortcut">⌘⇧↩</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void controller.resetLayout()}><RotateCcw size={14} />{t`Reset layout`}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="trellis-titlebar-group trellis-titlebar-presets">
        <LayoutSwitch controller={controller} compact={compact} />
      </div>
      <div className="trellis-titlebar-group trellis-titlebar-panel-toggles" role="group" aria-label={t`Show or hide panels`}>
        {TOGGLED_PANELS.map(({ kind, icon }) => {
          const shown = panelState(kind) === "shown";
          const name = title(kind);
          const label = spaceMixedScript(shown ? t`Hide ${name}` : t`Show ${name}`);
          return (
            <Tip key={kind} label={label}>
              <button
                type="button"
                className="trellis-titlebar-toggle"
                aria-label={label}
                aria-pressed={shown}
                onClick={() => controller.togglePanel(kind)}
              >
                {icon}
              </button>
            </Tip>
          );
        })}
      </div>
      <div className="trellis-titlebar-group trellis-titlebar-layout-actions">
        <Tip label={frameAction.tip}>
          <button type="button" className="trellis-titlebar-toggle" aria-label={frameAction.label} aria-pressed={Boolean(framed)} onClick={frameAction.run}>
            <frameAction.Icon size={14} />
          </button>
        </Tip>
        <Tip label={t`Reset layout`}>
          <button type="button" className="trellis-titlebar-toggle" aria-label={t`Reset layout`} onClick={() => void controller.resetLayout()}>
            <RotateCcw size={13} />
          </button>
        </Tip>
      </div>
      {hidden.length > 0 && (
        <div ref={chipsRef} className="trellis-titlebar-hidden" aria-label={t`Hidden panels`}>
          {hidden.map((entry) => (
            <Tip key={entry.panelId} label={spaceMixedScript(t`Restore ${entry.title}`)}>
              <button type="button" className="trellis-hidden-chip" onClick={() => ws()?.restore(entry.panelId)}>
                {entry.title}
              </button>
            </Tip>
          ))}
        </div>
      )}
    </div>
  );
});
