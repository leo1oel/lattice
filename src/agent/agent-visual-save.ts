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

/**
 * The Agent panel's request to show an inline visual larger than the panel
 * allows: its sandboxed host document, which Lattice loads as is in a frame of
 * the same sandbox over the whole window.
 */
export const SYNARA_EXPAND_VISUAL = "synara:expand-visual";

/** Synara refuses a visual's source above this (`INLINE_VISUAL_MAX_HTML_BYTES`). */
const MAX_VISUAL_BYTES = 256 * 1024;
const MAX_FILENAME_LENGTH = 120;
const MAX_TITLE_LENGTH = 200;
/** The source, escaped into the host document's `srcdoc`, plus its bootstrap. */
const MAX_DOCUMENT_LENGTH = 4 * 1024 * 1024;
/**
 * How every host document Synara builds begins: its policy, ahead of any other
 * byte, blocks the network, frames, forms and navigation for the visual inside.
 */
// eslint-disable-next-line lingui/no-unlocalized-strings -- HTML the panel builds, never shown
const HOST_DOCUMENT_PREFIX = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';`;
const VISUAL_SIZE_METHOD = "ui/notifications/size-changed";
const MIN_VISUAL_HEIGHT = 80;
const MAX_VISUAL_HEIGHT = 20_000;

export type AgentVisualSave = { filename: string; html: string };
export type AgentVisualExpand = { title: string; html: string; document: string };

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

/** The visual to show over the window, or null unless it is the sandboxed document Synara builds. */
export function parseAgentVisualExpand(data: Record<string, unknown>): AgentVisualExpand | null {
  const { title, html, document } = data;
  if (typeof title !== "string" || typeof html !== "string" || typeof document !== "string") return null;
  if (!html || new TextEncoder().encode(html).byteLength > MAX_VISUAL_BYTES) return null;
  if (document.length > MAX_DOCUMENT_LENGTH || !document.startsWith(HOST_DOCUMENT_PREFIX)) return null;
  return { title: title.trim().slice(0, MAX_TITLE_LENGTH) || i18n._(msg`Visual`), html, document };
}

/** The height an expanded visual's page reports, which is all Lattice reads from it. */
export function readAgentVisualHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== VISUAL_SIZE_METHOD || typeof params !== "object" || params === null) return null;
  const height = (params as Record<string, unknown>).height;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
  return Math.min(MAX_VISUAL_HEIGHT, Math.max(MIN_VISUAL_HEIGHT, Math.round(height)));
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
