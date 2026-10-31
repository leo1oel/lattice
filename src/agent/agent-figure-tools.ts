/* eslint-disable lingui/no-unlocalized-strings -- Protocol field names, LaTeX and Agent diagnostics are never rendered by Lattice UI. */

// The agent's view of a LaTeX figure before it is in the paper. The fork's
// `preview_latex_figure` tool asks over the presentation channel, the one
// that already carries a rendered page back as an image, with the action
// `preview_figure`. Rust typesets the figure body alone in a scratch folder
// with the paper's preamble, at the paper's column width
// (src-tauri/src/latex/figure_preview.rs), and this renders the one-page PDF
// it returns as a PNG.
//
// Inserting is not a host action: given a caption and label, the result
// carries the `figure` environment to insert, and the agent writes it with its
// ordinary file edit, so the change is approved, checkpointed and undone like
// any other agent edit.

import { invoke } from "@tauri-apps/api/core";
import { isRecord, toMessage } from "../app-utils";
import { PDF_CMAP_URL, PDF_STANDARD_FONT_DATA_URL } from "../pdf/pdf-viewer-utils";
import {
  hasOnlyKeys, isWorkspaceRelativePath, parseToolEnvelope, runAgentTool, toolError, type AgentToolResult,
} from "./agent-protocol";
import { LATTICE_PRESENTATION_TOOL_RESULT, SYNARA_PRESENTATION_TOOL_REQUEST } from "./agent-presentation-tools";

/** The bounds Rust enforces again: the body, and the preamble lines beside it. */
const MAX_CODE_LENGTH = 256 * 1024;
const MAX_PREAMBLE_LENGTH = 32 * 1024;
const MAX_CAPTION_LENGTH = 2_000;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9:_./+-]{0,119}$/;
const PLACEMENT = /^[htbpH!]{1,5}$/;
/** The longest side of the image: about what a vision model reads without scaling it down. */
const MAX_IMAGE_SIDE = 1_536;
/** Three device pixels per point at most, so a small figure is not blown up into blur. */
const MAX_SCALE = 3;
/** 4 MiB as base64, the inline bound every image the agent receives keeps. */
const MAX_IMAGE_DATA = Math.ceil((4 * 1024 * 1024) / 3) * 4;
/** The white space the page adds around the figure, both sides together (MARGINS in figure_preview.rs). */
const PAGE_MARGINS_PT = 4;

type FigureArgs = {
  code: string;
  preamble?: string;
  document?: string;
  lineWidth?: string;
  caption?: string;
  label?: string;
  placement?: string;
  wide?: boolean;
};

export type AgentFigureToolRequest = {
  type: typeof SYNARA_PRESENTATION_TOOL_REQUEST;
  version: 1;
  id: string;
  action: "preview_figure";
  args: FigureArgs;
  expiresAt: number;
};

/** What `preview_latex_figure` returns (latex/figure_preview.rs). */
type FigurePreview = {
  pdf: string | null;
  errors: string[];
  warnings: string[];
  preambleFrom: string | null;
  preambleFallback: string | null;
  preambleToAdd: string[];
  lineWidth: string;
  engine: string;
  durationMs: number;
};

type PreviewFigureResult = {
  engine: string;
  lineWidth: string;
  /** The document whose preamble typeset the figure; null for a plain article. */
  preambleFrom: string | null;
  preambleFallback?: string;
  preambleToAdd: string[];
  warnings: string[];
  size: { widthPt: number; heightPt: number };
  /** The environment to insert, when a caption and label were given. */
  figure?: string;
  image: { mimeType: "image/png" | "image/jpeg"; width: number; height: number; data: string };
};

export type AgentFigureToolResult = AgentToolResult<typeof LATTICE_PRESENTATION_TOOL_RESULT, PreviewFigureResult>;

const optionalString = (value: unknown, maxLength: number) =>
  value === undefined || (typeof value === "string" && value.length <= maxLength);

export function parseAgentFigureToolRequest(value: unknown): AgentFigureToolRequest | null {
  const request = parseToolEnvelope(value, SYNARA_PRESENTATION_TOOL_REQUEST, ["action", "args"]);
  if (!request || request.action !== "preview_figure") return null;
  const { args } = request;
  const keys = ["code", "preamble", "document", "lineWidth", "caption", "label", "placement", "wide"];
  if (!isRecord(args) || !hasOnlyKeys(args, keys)) return null;
  if (typeof args.code !== "string" || !args.code.trim() || args.code.length > MAX_CODE_LENGTH) return null;
  if (!optionalString(args.preamble, MAX_PREAMBLE_LENGTH) || !optionalString(args.lineWidth, 64)) return null;
  if (args.document !== undefined && !isWorkspaceRelativePath(args.document)) return null;
  if (!optionalString(args.caption, MAX_CAPTION_LENGTH)) return null;
  if (args.label !== undefined && (typeof args.label !== "string" || !LABEL.test(args.label))) return null;
  if (args.placement !== undefined && (typeof args.placement !== "string" || !PLACEMENT.test(args.placement))) return null;
  if (args.wide !== undefined && typeof args.wide !== "boolean") return null;
  return request as AgentFigureToolRequest;
}

export function executeAgentFigureToolRequest(
  request: AgentFigureToolRequest,
  projectRoot: string | null,
): Promise<AgentFigureToolResult> {
  return runAgentTool(LATTICE_PRESENTATION_TOOL_RESULT, request.id, "figure_preview_failed", () =>
    previewFigure(request, projectRoot));
}

async function previewFigure({ args, expiresAt }: AgentFigureToolRequest, projectRoot: string | null) {
  if (expiresAt <= Date.now()) throw toolError("The figure preview request expired before execution.", "figure_tool_expired");
  if (!projectRoot) throw toolError("No Lattice project is open.", "figure_host_unavailable");
  const figure = args.caption !== undefined || args.label !== undefined ? figureEnvironment(args) : undefined;
  const preview = await invoke<FigurePreview>("preview_latex_figure", {
    projectRoot,
    request: {
      code: args.code,
      preamble: args.preamble,
      document: args.document,
      lineWidth: args.lineWidth ?? (args.wide ? "\\textwidth" : undefined),
    },
  }).catch((reason: unknown) => {
    throw toolError(toMessage(reason), "figure_preview_failed");
  });
  if (!preview.pdf) {
    const errors = preview.errors.length ? preview.errors : ["The figure did not typeset."];
    throw toolError(
      `The figure does not typeset. Fix ${errors.length === 1 ? "this error" : `these ${errors.length} errors`}, then preview again:\n\n${errors.join("\n\n")}`,
      "figure_build_failed",
    );
  }
  const { image, size } = await renderFigure(preview.pdf);
  return {
    engine: preview.engine,
    lineWidth: preview.lineWidth,
    preambleFrom: preview.preambleFrom,
    ...(preview.preambleFallback ? { preambleFallback: preview.preambleFallback } : {}),
    preambleToAdd: preview.preambleToAdd,
    warnings: preview.warnings,
    size,
    ...(figure ? { figure } : {}),
    image,
  } satisfies PreviewFigureResult;
}

/**
 * The `figure` (or `figure*`) environment around `code`, as it goes in the
 * paper: centred unless the code centres itself, the caption below.
 */
export function figureEnvironment({ code, caption, label, placement, wide }: FigureArgs): string {
  if (!caption?.trim() || !label) {
    throw toolError("Give both caption and label to get the figure environment to insert.", "figure_invalid_input");
  }
  if (!balancedBraces(caption)) throw toolError("The caption's braces do not balance.", "figure_invalid_input");
  const environment = wide ? "figure*" : "figure";
  const body = code.replace(/^\s*\n|\s+$/g, "");
  const indented = body.split("\n").map((line) => (line.trim() ? `  ${line}` : "")).join("\n");
  return [
    `\\begin{${environment}}[${placement ?? "t"}]`,
    ...(/^\s*\\centering\b/.test(body) ? [] : ["  \\centering"]),
    indented,
    `  \\caption{${caption.trim()}}`,
    `  \\label{${label}}`,
    `\\end{${environment}}`,
  ].join("\n");
}

function balancedBraces(text: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") index += 1;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/** Page 1 of the figure's PDF as an image, and the page's size in points. */
async function renderFigure(base64: string) {
  // PDF.js stays out of startup: only a figure preview or the PDF panel loads it.
  const { getDocument } = await import("../pdf/pdfjs-runtime");
  const loadingTask = getDocument({
    data: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
    // As the main viewer: WKWebView can paint embedded Type 1 FontFace glyphs blank.
    disableFontFace: true,
    useSystemFonts: false,
  });
  try {
    const page = await (await loadingTask.promise).getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_SCALE, MAX_IMAGE_SIDE / Math.max(1, natural.width, natural.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport, background: "#FFFFFF" }).promise;
    // Line art is sharper and smaller as PNG; a photo-heavy figure may only fit as JPEG.
    let mimeType: "image/png" | "image/jpeg" = "image/png";
    let data = canvas.toDataURL(mimeType).split(",", 2)[1] ?? "";
    if (data.length > MAX_IMAGE_DATA) {
      mimeType = "image/jpeg";
      data = canvas.toDataURL(mimeType, 0.9).split(",", 2)[1] ?? "";
    }
    if (!data) throw toolError("The figure could not be drawn as an image.", "figure_preview_failed");
    if (data.length > MAX_IMAGE_DATA) throw toolError("The figure image is too large to return.", "figure_preview_too_large");
    const points = (value: number) => Math.round(value * 10) / 10;
    return {
      image: { mimeType, width: canvas.width, height: canvas.height, data },
      size: { widthPt: points(natural.width - PAGE_MARGINS_PT), heightPt: points(natural.height - PAGE_MARGINS_PT) },
    };
  } finally {
    await loadingTask.destroy();
  }
}
