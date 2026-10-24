/**
 * Lets the agent's spreadsheet tools open the project's spreadsheets: each is
 * read from disk into a document the tools edit, and written back as a save
 * the rest of App sees (Overleaf pushes follow it).
 */
import { useEffect, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadAgentSpreadsheetModel, registerAgentSpreadsheetDocumentResolver } from "../agent/agent-spreadsheet-tools";

export function useAgentSpreadsheetResolver(
  projectRootRef: RefObject<string | null>,
  recordSavedPaths: (paths: readonly string[]) => void,
) {
  useEffect(() => registerAgentSpreadsheetDocumentResolver(async (path) => {
    const projectRoot = projectRootRef.current;
    if (!projectRoot) return null;
    const content = await invoke<string>("read_project_file", { path, projectRoot });
    const { openSpreadsheetDoc, spreadsheetDocContent } = await loadAgentSpreadsheetModel();
    const doc = openSpreadsheetDoc(content);
    return {
      doc,
      canWrite: true,
      path,
      commit: async () => {
        await invoke<void>("write_project_file", { path, content: spreadsheetDocContent(doc), projectRoot });
        recordSavedPaths([path]);
      },
      dispose: () => doc.destroy(),
    };
  }), [projectRootRef, recordSavedPaths]);
}
