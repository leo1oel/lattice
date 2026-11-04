/* eslint-disable lingui/no-unlocalized-strings -- closed model-facing bridge protocol */
import { isRecord } from "../app-utils";
const READ_ONLY_MESSAGES = new Set([
  "synara:embed-ready", "synara:open-settings", "synara:open-file", "synara:open-external", "synara:open-review",
  "synara:expand-visual", "lattice:request-host-context", "lattice:request-paper-library", "lattice:request-host-theme",
  "lattice:clear-host-context-selection", "synara:editor-comments-tool-request", "synara:composer-prompt-result",
  "synara:turn-activity", "synara:agent-permission-mode", "synara:layout-metrics",
  // This is the sole host write broker allowed by staged mode; its existing
  // parser closes the action/parameter set and checks the active project.
  "synara:bibliography-tool-request",
]);
const TOOL_RESULTS: Record<string, string> = {
  "synara:project-document-tool-request": "lattice:project-document-tool-result",
  "synara:canvas-tool-request": "lattice:canvas-tool-result",
  "synara:spreadsheet-tool-request": "lattice:spreadsheet-tool-result",
  "synara:presentation-tool-request": "lattice:presentation-tool-result",
  "synara:annotations-tool-request": "lattice:annotations-tool-result",
};
export function stagedHostMessage(data: unknown): { allowed: boolean; response?: object } {
  if (!isRecord(data) || typeof data.type !== "string") return { allowed: false };
  if (READ_ONLY_MESSAGES.has(data.type)) return { allowed: true };
  const type = Object.hasOwn(TOOL_RESULTS, data.type) ? TOOL_RESULTS[data.type] : undefined;
  if (type && typeof data.id === "string" && data.id.length <= 200) return { allowed: false, response: {
    type, version: 1, id: data.id, ok: false,
    error: { code: "headless_staged_tool_unsupported", message: "This host editing tool is unavailable in staged mode. Edit ordinary text in the isolated workspace and use Apply checked changes." },
  } };
  return { allowed: false };
}
