/**
 * The Agent's tool calls on the document a page holds: the board's canvas
 * tools, the spreadsheet's range tools and the deck's page preview.
 *
 * In the Tauri app the Agent's host and every open document share one
 * window, so `use-synara-host.ts` runs a tool call against the editor's own
 * registration (`registerAgentCanvasAdapter`, `registerAgentSpreadsheetDocument`,
 * `activeOpenSlideRefresh`) directly. In the GPUI app each document is a page
 * of its own: the Agent island hands the call to its owner, which sends it
 * here, to the page whose editor registered, and this runs the Tauri app's own
 * executor against that registration and answers with its result envelope.
 * The envelope is the one the Synara frame reads; the Agent island posts it
 * to the frame as it is.
 *
 * Host to page:
 *   agent:tool           { id, path, request }   a Synara tool request for this page's document
 *   agent:await-document { id, path, timeoutMs } the editor for `path` has registered (a created document)
 * Page to host:
 *   agent:tool-result    { id, result }          the executor's envelope, or `{ ready: true }`
 *   agent:tool-result    { id, error }           what stopped it before an envelope existed
 */
import { host } from "./host";
import { toMessage } from "../../../src/app-utils";
import {
  executeAgentCanvasToolRequest, parseAgentCanvasToolRequest, waitForAgentCanvasAdapter,
} from "../../../src/agent/agent-canvas-tools";
import {
  executeAgentSpreadsheetToolRequest, parseAgentSpreadsheetToolRequest, waitForAgentSpreadsheetDocument,
} from "../../../src/agent/agent-spreadsheet-tools";
import {
  executeAgentPresentationToolRequest, parseAgentPresentationToolRequest,
} from "../../../src/agent/agent-presentation-tools";

/** Which of the Tauri app's executors a page's document answers. */
export type AgentToolDocument = "board" | "sheet" | "deck";

/**
 * The longest a routed call waits for its editor to register: a page the
 * owner routes to has drawn, but tldraw registers its adapter only once its
 * editor mounts, a moment later.
 */
const REGISTRATION_WAIT_MS = 5_000;

function remaining(expiresAt: unknown, cap: number) {
  const left = typeof expiresAt === "number" ? expiresAt - Date.now() : 0;
  return Math.max(0, Math.min(cap, left));
}

/** Run `request` against this page's registration, as `use-synara-host.ts` runs it. */
async function execute(
  document: AgentToolDocument,
  path: string,
  request: unknown,
  projectRoot: () => string | null,
): Promise<object> {
  if (document === "board") {
    const parsed = parseAgentCanvasToolRequest(request);
    if (!parsed) throw new Error("not a canvas tool request");
    await waitForAgentCanvasAdapter(path, remaining(parsed.expiresAt, REGISTRATION_WAIT_MS)).catch(() => undefined);
    return executeAgentCanvasToolRequest(parsed);
  }
  if (document === "sheet") {
    const parsed = parseAgentSpreadsheetToolRequest(request);
    if (!parsed) throw new Error("not a spreadsheet tool request");
    await waitForAgentSpreadsheetDocument(path, remaining(parsed.expiresAt, REGISTRATION_WAIT_MS)).catch(() => undefined);
    return executeAgentSpreadsheetToolRequest(parsed);
  }
  const parsed = parseAgentPresentationToolRequest(request);
  if (!parsed) throw new Error("not a presentation tool request");
  return executeAgentPresentationToolRequest(parsed, projectRoot());
}

/** Wait for the editor of a document the Agent created to register (`createAgentProjectDocument`). */
function awaitDocument(document: AgentToolDocument, path: string, timeoutMs: number): Promise<void> {
  if (document === "board") return waitForAgentCanvasAdapter(path, timeoutMs);
  if (document === "sheet") return waitForAgentSpreadsheetDocument(path, timeoutMs);
  return Promise.resolve();
}

/**
 * Answer the owner's `agent:tool` and `agent:await-document` on this page;
 * `projectRoot` is the deck's project (a deck's preview names it).
 */
export function serveAgentTools(document: AgentToolDocument, projectRoot: () => string | null = () => null): () => void {
  const bridge = host();
  const answer = (id: unknown, work: Promise<object>) => {
    void work.then(
      (result) => bridge.post("agent:tool-result", { id, result }),
      (error: unknown) => bridge.post("agent:tool-result", { id, error: toMessage(error) }),
    );
  };
  const stops = [
    bridge.on("agent:tool", (payload) => {
      const { id, path, request } = (payload ?? {}) as { id?: unknown; path?: unknown; request?: unknown };
      answer(id, execute(document, typeof path === "string" ? path : "", request, projectRoot));
    }),
    bridge.on("agent:await-document", (payload) => {
      const { id, path, timeoutMs } = (payload ?? {}) as { id?: unknown; path?: unknown; timeoutMs?: unknown };
      const wait = typeof timeoutMs === "number" ? timeoutMs : 0;
      answer(id, awaitDocument(document, typeof path === "string" ? path : "", wait).then(() => ({ ready: true })));
    }),
  ];
  return () => { for (const stop of stops) stop(); };
}
