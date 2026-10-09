/* eslint-disable lingui/no-unlocalized-strings -- Protocol field names and Agent diagnostics are never rendered by Lattice UI. */

// The agent's view of an Open Slide page. Lattice loads the runtime's
// token-gated preview entry (`/__lattice/preview/<deck>`, which forwards to
// Open Slide's chrome-less `/s/<deck>/preview?p=N`) in a hidden 1920 × 1080
// frame and asks that page for itself as an image (PREVIEW_CAPTURE_SOURCE in
// tools/open-slide-runtime/server.mjs). It works without the agent's shell or
// a local browser, and in a browser-hosted workspace as in the native window.

import { invoke } from "@tauri-apps/api/core";
import { isRecord, toMessage } from "../app-utils";
import { activeOpenSlideRefresh } from "../editor/presentation/open-slide-bridge";
import { hasOnlyKeys, parseToolEnvelope, runAgentTool, toolError, type AgentToolResult } from "./agent-protocol";

export const SYNARA_PRESENTATION_TOOL_REQUEST = "synara:presentation-tool-request";
const LATTICE_PRESENTATION_TOOL_RESULT = "lattice:presentation-tool-result";
const PREVIEW_CAPTURE_REQUEST = "lattice:preview-capture";
const PREVIEW_CAPTURE_RESULT = "lattice:preview-capture-result";
/** Open Slide's deck ids, as `deckIdFromOpenSlidePath` reads them from `slides/<deck>/index.tsx`. */
const DECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const MAX_PAGE = 10_000;
/** 4 MiB of JPEG as base64, the inline bound the agent's device screenshots get; the agent's result route accepts 8 MiB. */
const MAX_IMAGE_DATA = Math.ceil((4 * 1024 * 1024) / 3) * 4;
/** Covers a cold runtime start (30 s) plus the page's own 20 s settle bound. */
const CAPTURE_TIMEOUT_MS = 60_000;

type PreviewArgs = { deck: string; page: number; step?: number };

export type AgentPresentationToolRequest = {
  type: typeof SYNARA_PRESENTATION_TOOL_REQUEST;
  version: 1;
  id: string;
  action: "preview_page";
  args: PreviewArgs;
  expiresAt: number;
};

type PreviewPageResult = {
  deck: string;
  page: number;
  pageCount: number | null;
  step?: number;
  image: { mimeType: "image/jpeg"; width: number; height: number; data: string };
};

export type AgentPresentationToolResult = AgentToolResult<typeof LATTICE_PRESENTATION_TOOL_RESULT, PreviewPageResult>;

/** The parts of the `presentation_ensure_ready` payload this tool reads. */
type PresentationRuntimeInfo = { origin: string | null; sessionUrl: string | null; leaseId: string | null };

type CaptureReply = {
  ok: boolean;
  page?: number | null;
  total?: number | null;
  width?: number;
  height?: number;
  dataUrl?: string;
  message?: string;
};

const isPageNumber = (value: unknown, minimum: number): value is number =>
  Number.isInteger(value) && (value as number) >= minimum && (value as number) <= MAX_PAGE;

export function parseAgentPresentationToolRequest(value: unknown): AgentPresentationToolRequest | null {
  const request = parseToolEnvelope(value, SYNARA_PRESENTATION_TOOL_REQUEST, ["action", "args"]);
  if (!request || request.action !== "preview_page") return null;
  const { args } = request;
  if (!isRecord(args) || !hasOnlyKeys(args, ["deck", "page", "step"])) return null;
  if (typeof args.deck !== "string" || !DECK_ID.test(args.deck) || !isPageNumber(args.page, 1)) return null;
  if (args.step !== undefined && !isPageNumber(args.step, 0)) return null;
  return request as AgentPresentationToolRequest;
}

// One hidden 1920 × 1080 frame at a time: each one is a full render of a page.
let captureQueue: Promise<unknown> = Promise.resolve();

export function executeAgentPresentationToolRequest(
  request: AgentPresentationToolRequest,
  projectRoot: string | null,
): Promise<AgentPresentationToolResult> {
  return runAgentTool(LATTICE_PRESENTATION_TOOL_RESULT, request.id, "presentation_preview_failed", () => {
    const run = captureQueue.then(() => previewPage(request, projectRoot));
    captureQueue = run.catch(() => undefined);
    return run;
  });
}

async function previewPage(
  { args, expiresAt }: AgentPresentationToolRequest,
  projectRoot: string | null,
): Promise<PreviewPageResult> {
  if (expiresAt <= Date.now()) {
    throw toolError("The page preview request expired before execution.", "presentation_tool_expired");
  }
  if (!projectRoot) throw toolError("No Lattice project is open.", "presentation_host_unavailable");
  const info = await invoke<PresentationRuntimeInfo>("presentation_ensure_ready", { projectRoot })
    .catch((reason: unknown) => {
      throw toolError(toMessage(reason), "presentation_runtime_unavailable");
    });
  try {
    const token = info.sessionUrl ? new URL(info.sessionUrl).searchParams.get("token") : null;
    if (!info.origin || !token) throw toolError("Open Slide is not ready.", "presentation_runtime_unavailable");
    // The agent usually previews right after writing the deck, before the
    // file watcher's debounced refresh has reached the runtime's copy.
    const refresh = activeOpenSlideRefresh(projectRoot);
    await (refresh ? refresh() : invoke("presentation_refresh_native_workspace", { projectRoot }));
    const url = new URL(`/__lattice/preview/${args.deck}`, info.origin);
    url.searchParams.set("token", token);
    url.searchParams.set("p", String(args.page));
    if (args.step !== undefined) url.searchParams.set("step", String(args.step));
    const reply = await captureFrame(url.href, info.origin, Math.min(CAPTURE_TIMEOUT_MS, expiresAt - Date.now()));
    return previewResult(args, reply);
  } finally {
    if (info.leaseId) void invoke("presentation_release", { projectRoot, leaseId: info.leaseId }).catch(() => undefined);
  }
}

function previewResult(args: PreviewArgs, reply: CaptureReply): PreviewPageResult {
  const pageCount = reply.total ?? null;
  if (!reply.ok) {
    const message = reply.message ?? "The page could not be previewed.";
    if (pageCount !== null && args.page > pageCount) throw toolError(message, "presentation_page_out_of_range");
    // Open Slide's slide loader names an unknown deck this way.
    if (pageCount === null && message.startsWith("Slide not found")) {
      throw toolError(
        `No deck "${args.deck}" in this project (expected slides/${args.deck}/index.tsx).`,
        "presentation_deck_not_found",
      );
    }
    throw toolError(message, "presentation_preview_failed");
  }
  const data = reply.dataUrl?.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/)?.[1];
  if (!data || !reply.width || !reply.height) {
    throw toolError("The preview page returned no image.", "presentation_preview_failed");
  }
  if (data.length > MAX_IMAGE_DATA) {
    throw toolError("The page image is too large to return.", "presentation_preview_too_large");
  }
  return {
    deck: args.deck,
    page: args.page,
    pageCount,
    ...(args.step === undefined ? {} : { step: args.step }),
    image: { mimeType: "image/jpeg", width: reply.width, height: reply.height, data },
  };
}

/**
 * Load `src` in a hidden frame laid out at Open Slide's native 1920 × 1080 and
 * resolve with the preview page's answer. The frame stays inside the viewport
 * (scaled down and transparent) because browsers throttle the rendering of
 * off-screen cross-origin frames, and the page settles on animation frames.
 */
function captureFrame(src: string, origin: string, timeoutMs: number): Promise<CaptureReply> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.tabIndex = -1;
    Object.assign(frame.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "1920px",
      height: "1080px",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
      transform: "scale(0.01)",
      transformOrigin: "0 0",
      zIndex: "-1",
    });
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      frame.remove();
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      const data: unknown = event.data;
      if (!isRecord(data) || data.type !== PREVIEW_CAPTURE_RESULT || data.id !== id) return;
      finish();
      resolve(data as CaptureReply);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(toolError(
        `The page preview did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
        "presentation_preview_timeout",
      ));
    }, Math.max(0, timeoutMs));
    // The entry first loads a bootstrap document, which ignores the request,
    // then the preview page, whose capture module is ready by its load event.
    frame.addEventListener("load", () => {
      frame.contentWindow?.postMessage({ type: PREVIEW_CAPTURE_REQUEST, id }, origin);
    });
    window.addEventListener("message", receive);
    frame.src = src;
    document.body.append(frame);
  });
}
