/**
 * The Terminal panel as a Trellis view: its content and its header button.
 * These ride in the workspace's chunk and are a few lines each; xterm.js,
 * the panel and the shells' plumbing load only when a Terminal panel first
 * mounts (`loadTerminalPanel`), so a window that never opens one never pays
 * for any of it.
 */
import { Suspense, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { useCloseGuard, useView, useWorkspaceSelector } from "@danfessler/trellis-react";
import { Play, Plus, Square } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { lazyChunk } from "../lib/lazy-chunk";
import type { TrellisController } from "../trellis/trellis-controller";
import { loadTerminalPanel, withTerminals } from "./terminal-load";

const TerminalPanel = lazyChunk(loadTerminalPanel, (module) => module.TerminalPanel);
const CodeRunDialog = lazyChunk(loadTerminalPanel, (module) => module.CodeRunDialog);

export function TerminalView({ controller }: { controller: TrellisController }) {
  const view = useView();
  const moving = useWorkspaceSelector((state) => state.dragging);
  // Closing the panel ends its shells (hiding it keeps them). A layout reset
  // or a workspace without the panel skips this guard: the shells wait for
  // the panel to come back.
  useCloseGuard(async () => {
    const module = loadTerminalPanel.loaded();
    return module ? module.closeAllTerminals() : true;
  });
  return (
    <Suspense fallback={null}>
      <TerminalPanel controller={controller} shown={view.visible} focused={view.focused} moving={moving} />
    </Suspense>
  );
}

/** The header's New terminal button. */
export function TerminalActions({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  const [running, dispatch] = useReducer((_previous: boolean, action: "open" | "close") => action === "open", false);
  return (
    <span className="trellis-accessory-host terminal-actions">
      <Tip label={t`Run current file`}>
        <button type="button" aria-label={t`Run current file`} onClick={() => dispatch("open")}><Play size={14} /></button>
      </Tip>
      <Tip label={t`Interrupt command`}>
        <button type="button" aria-label={t`Interrupt command`} onClick={withTerminals((module) => module.interruptActiveTerminal())}><Square size={14} /></button>
      </Tip>
      <Tip label={t`New terminal`}>
        <button type="button" aria-label={t`New terminal`} onClick={withTerminals((module) => module.openTerminal())}>
          <Plus size={14} />
        </button>
      </Tip>
      {running && <Suspense fallback={null}><CodeRunDialog controller={controller} onClose={() => dispatch("close")} /></Suspense>}
    </span>
  );
}
