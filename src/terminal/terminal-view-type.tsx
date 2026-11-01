/** The workspace's `<ViewType>` for the Terminal panel: Trellis reads a workspace's view types from its direct children. */
import { msg } from "@lingui/core/macro";
import { ViewType } from "@danfessler/trellis-react";
import type { MenuEntry } from "@danfessler/trellis";
import { i18n } from "../i18n";
import { PanelErrorBoundary } from "../telemetry/panel-error-boundary";
import type { TrellisController } from "../trellis/trellis-controller";
import { PANEL_TITLES } from "../trellis/trellis-titles";
import { TERMINAL_ICON } from "./terminal-icon";
import { withTerminals } from "./terminal-load";
import { TerminalActions, TerminalView } from "./terminal-view";

/** A terminal needs a few columns and a couple of lines to be of use. */
const MIN_SIZE = { width: 240, height: 120 } as const;

/** The panel menu's own entries, ahead of Trellis's (hide, float, close). */
const menu = (): MenuEntry[] => [
  { id: "terminal-new", label: i18n._(msg`New terminal`), run: withTerminals((module) => module.openTerminal()) },
  { id: "terminal-find", label: i18n._(msg`Find in terminal`), shortcut: "⌘F", run: withTerminals((module) => module.findInActiveTerminal()) },
  { id: "terminal-clear", label: i18n._(msg`Clear terminal`), run: withTerminals((module) => module.clearActiveTerminal()) },
];

export function terminalViewType(controller: TrellisController) {
  return (
    <ViewType
      key="terminal" id="terminal" title={i18n._(PANEL_TITLES.terminal)} singleton icon={TERMINAL_ICON} minSize={MIN_SIZE} scaling={false}
      accessory={<TerminalActions />} menu={menu}
    >
      <PanelErrorBoundary name="terminal"><TerminalView controller={controller} /></PanelErrorBoundary>
    </ViewType>
  );
}
