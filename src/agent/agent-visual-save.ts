import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { i18n } from "../i18n";
import { utf8ToBase64 } from "../pdf/pdf-bytes";
import { logAction } from "../telemetry/app-notify";

/**
 * The Agent panel's request to save an inline visual's HTML. WebKit cancels a
 * download that starts in a frame unless the native host handles it, so the
 * panel hands the source here and Lattice saves it where the writer chooses.
 */
export const SYNARA_SAVE_VISUAL = "synara:save-visual";

/** Synara refuses a visual's source above this (`INLINE_VISUAL_MAX_HTML_BYTES`). */
const MAX_VISUAL_BYTES = 256 * 1024;
const MAX_FILENAME_LENGTH = 120;

export type AgentVisualSave = { filename: string; html: string };

/** The request's fields, or null for anything malformed or oversized. */
export function parseAgentVisualSave(data: Record<string, unknown>): AgentVisualSave | null {
  const { filename, html } = data;
  if (typeof filename !== "string" || typeof html !== "string" || !html) return null;
  if (new TextEncoder().encode(html).byteLength > MAX_VISUAL_BYTES) return null;
  // Only a suggestion for the save panel: a bare name, never a path.
  const name = filename
    .replace(/[\p{Cc}\\/:*?"<>|]+/gu, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, MAX_FILENAME_LENGTH)
    .trim();
  const base = name.replace(/\.html?$/i, "").trim() || i18n._(msg`Visual`);
  return { filename: `${base}.html`, html };
}

/** Ask where to save the visual, then write it there; a cancelled panel saves nothing. */
export function saveAgentVisual(request: AgentVisualSave): void {
  const trace = logAction(i18n._(msg`Agent`), i18n._(msg`Save visual`), request.filename);
  void saveDialog({
    title: i18n._(msg`Save visual as HTML`),
    defaultPath: request.filename,
    filters: [{ name: i18n._(msg`HTML document`), extensions: ["html"] }],
  })
    .then(async (destination) => {
      if (!destination) return;
      const path = await invoke<string>("save_agent_visual", new TextEncoder().encode(request.html), {
        headers: { "x-html-destination": utf8ToBase64(destination) },
      });
      trace.ok(i18n._(msg`Saved to ${path}`));
    })
    .catch((reason: unknown) => trace.fail(reason));
}
