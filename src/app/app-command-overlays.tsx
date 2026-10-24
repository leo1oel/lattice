/**
 * The command table's two overlays (use-command-table.ts): the ⌘K palette and
 * the ⌘? shortcut sheet, over the welcome screen and a project alike.
 */
import { lazy, memo } from "react";
import { useLingui } from "@lingui/react/macro";
import { LazyMount } from "../components/lazy-mount";
import { CommandPalette } from "./command-palette";
import { paletteLeading } from "./command-palette-leading";
import { paletteEntries } from "./use-app-commands";
import type { useCommandTable } from "./use-command-table";

const ShortcutSheet = lazy(() => import("./shortcut-sheet"));

type CommandOverlaysProps = Pick<ReturnType<typeof useCommandTable>, "commands" | "overlay">;

const closed = ({ overlay }: CommandOverlaysProps) => !overlay.palette && !overlay.shortcuts;

/** Closed, it does not re-render with App: neither overlay is shown, as LazyMount does for the sheet. */
export const AppCommandOverlays = memo(function AppCommandOverlays({ commands, overlay }: CommandOverlaysProps) {
  const { t } = useLingui();
  const { palette } = overlay;
  const paletteCommands = palette ? paletteEntries(commands) : [];
  return (
    <>
      {palette && (
        <CommandPalette
          commands={paletteCommands}
          leading={paletteLeading(paletteCommands, palette.recentCommands, palette.surface, {
            recent: t`Recent`,
            surface: palette.surface === "paper" ? t`In this paper` : t`In this document`,
          })}
          files={palette.files}
          recentFiles={palette.recentFiles}
          papers={palette.papers}
          hasProject={palette.hasProject}
          knownAuthorName={palette.knownAuthorName}
          onFileIntent={palette.onFileIntent}
          onClose={overlay.close}
          onChoose={overlay.choose}
        />
      )}
      {/* The welcome screen's shortcuts are listed too. */}
      <LazyMount when={overlay.shortcuts}>
        <ShortcutSheet commands={commands} onClose={overlay.close} />
      </LazyMount>
    </>
  );
}, (previous, next) => closed(previous) && closed(next));
