/**
 * How a plugin command chosen in the palette reaches the app
 * (`PluginRunHost`, plugins/plugin-run.tsx): where the writer is when it
 * runs, and the app's own ways to perform what it returns. Built with the
 * command table, from the same documents and canvas requests its commands use.
 */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { EditorPosition, ProjectSnapshot } from "../app-types";
import type { AgentSelectionLines } from "../agent/agent-host-context";
import { i18n } from "../i18n";
import type { PluginPageContext } from "../plugins/plugin-ipc";
import type { PluginRunHost } from "../plugins/plugin-run";
import { showError, showingErrors, showNotice } from "./notify";
import type { UpdateCanvasRequest } from "./use-canvas-requests";

export function pluginPaletteHost({
  project, activeFile, textDocument, agentContext, updateCanvasRequest, openFile, rewriteBibliography, openSettings,
}: {
  project: ProjectSnapshot | null;
  activeFile: string;
  /** A source file is open (not a Paper or an asset), so its path is the active file. */
  textDocument: boolean;
  /** The caret, and the selection when the editor owns one. */
  agentContext: {
    editorPosition: EditorPosition | null;
    selectionSource: string | null;
    selection: string;
    selectionLines: AgentSelectionLines | null;
  };
  updateCanvasRequest: UpdateCanvasRequest;
  openFile: (path: string, options?: { line?: number }) => Promise<unknown>;
  rewriteBibliography: PluginRunHost["bibliography"]["rewrite"];
  openSettings: () => void;
}): PluginRunHost {
  const root = project?.root ?? null;
  const { editorPosition } = agentContext;
  const selection = agentContext.selectionSource === "editor" ? { text: agentContext.selection, lines: agentContext.selectionLines } : null;
  const context = (): PluginPageContext | null => {
    if (!project) return null;
    const file = editorPosition?.path || (textDocument ? activeFile : "");
    const cursorLine = editorPosition?.line ?? 1;
    return {
      mainDocument: project.manifest.rootDocuments.find((document) => document.isDefault)?.path,
      activeFile: textDocument && activeFile ? activeFile : undefined,
      // The editor reports a selection's lines, not its columns: the whole
      // lines it spans, which is what a plugin reading the text needs.
      selection: selection?.text && file ? {
        text: selection.text,
        file,
        from: { line: selection.lines?.start ?? cursorLine, column: 1 },
        to: { line: selection.lines?.end ?? cursorLine, column: 1 },
      } : undefined,
      cursor: editorPosition ? {
        file: editorPosition.path,
        position: { line: editorPosition.line, column: editorPosition.column + 1 },
      } : undefined,
    };
  };
  return {
    projectRoot: root,
    locale: i18n.locale || "en",
    context,
    // Once the palette has handed focus back to the editor, as a palette
    // command runs (use-command-table.ts): a citation lands at its caret.
    perform: (action) => window.setTimeout(() => window.setTimeout(() => {
      switch (action.type) {
        case "insertCitation":
          updateCanvasRequest("cite", { key: action.key, command: "cite", id: crypto.randomUUID() });
          return;
        case "reveal":
          void showingErrors(() => openFile(action.file, action.line ? { line: action.line } : undefined));
          return;
        case "openUrl":
          void openUrl(action.url).catch((reason: unknown) => showError(String(reason)));
          return;
        case "copy":
          void writeText(action.text)
            .catch(() => navigator.clipboard?.writeText(action.text))
            .then(() => showNotice(i18n._(msg`Copied`)), (reason: unknown) => showError(String(reason)));
      }
    }, 0), 0),
    bibliography: {
      primary: project?.manifest.primaryBibliography || null,
      read: (path) => invoke<string>("read_project_file", { path, projectRoot: root }),
      rewrite: rewriteBibliography,
    },
    openSettings,
  };
}
