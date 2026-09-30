/**
 * Titlebar controls for the Trellis workspace: a Panels menu that reopens any
 * panel or tool and resets the layout, one toggle each for Project, Papers and
 * the Agent, maximize/restore and reset, and a chip per hidden panel. The PDF
 * comes up from each .tex panel's Build button (and the Panels menu), and the
 * whole-workspace zoom lives in the Panels menu (⌘⌥↑).
 * Eager but light: it drives the workspace only through the controller.
 */
import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { Bot, FileText, FolderTree, LayoutPanelLeft, Library, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Tip } from "../components/icon-tip";
import { TOOL_KINDS, type TrellisController, type TrellisPanelState, type TrellisSingleton } from "./trellis-controller";
import { PANEL_TITLES, spaceMixedScript } from "./trellis-titles";

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

/** Memoized: App re-renders per keystroke and these controls only follow the workspace. */
export const TrellisTitlebar = memo(function TrellisTitlebar({ controller }: { controller: TrellisController }) {
  const { t, i18n } = useLingui();
  const hidden = useSyncExternalStore(controller.ui.subscribe, () => controller.ui.get().hidden);
  const framed = useSyncExternalStore(controller.ui.subscribe, () => controller.ui.get().framed);
  const panelState = usePanelStates(controller);
  const ws = () => controller.ws;
  const title = (kind: TrellisSingleton) => i18n._(PANEL_TITLES[kind]);
  return (
    <div className="trellis-titlebar">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className="trellis-titlebar-menu" aria-label={t`Panels`} data-trellis-panels-menu="">
            <LayoutPanelLeft size={14} />
            <span>{t`Panels`}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="min-w-[14rem]" onCloseAutoFocus={(event) => event.preventDefault()}>
          <DropdownMenuLabel>{t`Panels`}</DropdownMenuLabel>
          {CORE_PANELS.map(({ kind, icon }) => (
            <DropdownMenuItem key={kind} onSelect={() => controller.showPanel(kind)}>
              {icon}
              <span className="flex-1">{title(kind)}</span>
              {panelState(kind) !== "shown" && <span className="trellis-menu-state">{panelState(kind) === "hidden" ? t`Hidden` : t`Closed`}</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t`Tools`}</DropdownMenuLabel>
          {TOOL_KINDS.map((kind) => (
            <DropdownMenuItem key={kind} onSelect={() => controller.showPanel(kind)}>{title(kind)}</DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => ws()?.navigation.toggle()}>
            <span className="flex-1">{t`Maximize focused panel`}</span>
            <span className="trellis-menu-shortcut">⌘⇧↩</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => ws()?.navigation.frame("all")}>
            <span className="flex-1">{t`Zoom out to show every panel`}</span>
            <span className="trellis-menu-shortcut">⌘⌥↑</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void controller.resetLayout()}>{t`Reset layout`}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="trellis-titlebar-group" role="group" aria-label={t`Show or hide panels`}>
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
      <div className="trellis-titlebar-group">
        <Tip label={framed ? t`Restore the layout · ⌘⇧↩` : t`Maximize the focused panel · ⌘⇧↩ or double-click its tab bar`}>
          <button
            type="button"
            className="trellis-titlebar-toggle"
            aria-label={framed ? t`Restore the layout` : t`Maximize focused panel`}
            aria-pressed={Boolean(framed)}
            onClick={() => (framed ? ws()?.navigation.frame("all") : ws()?.navigation.toggle())}
          >
            {framed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </Tip>
        <Tip label={t`Reset layout`}>
          <button type="button" className="trellis-titlebar-toggle" aria-label={t`Reset layout`} onClick={() => void controller.resetLayout()}>
            <RotateCcw size={13} />
          </button>
        </Tip>
      </div>
      {hidden.length > 0 && (
        <div className="trellis-titlebar-hidden" aria-label={t`Hidden panels`}>
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
