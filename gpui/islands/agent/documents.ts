/**
 * The Agent's tool calls on the window's documents: a board's canvas tools,
 * a spreadsheet's range tools and a deck's page preview, and the boards and
 * sheets the Agent creates.
 *
 * In the Tauri app `use-synara-host.ts` runs these against the editor's own
 * registration in its one window. The GPUI app's documents are pages of
 * their own, so this page hands each call to its owner first
 * (`agent:document-tool`, answered in `shell/agent_documents.rs`): the owner
 * sends it to the open document whose editor registered for it, where the
 * Tauri app's executor runs (`../shared/agent-tools.ts`), and the result
 * envelope comes back to go to the frame as it is. When no open document
 * holds what the call needs, the owner says so (`local`) and the executor
 * runs here, as the Tauri app's does with nothing registered: the canvas
 * tools answer that no board is open, the range tools read and write a
 * closed sheet on disk (`useAgentSpreadsheetResolver`), and a page preview
 * starts Open Slide itself.
 *
 * The host's own listener (`use-synara-host.ts`) would run the same calls
 * against this page's empty registries, so the listener here runs ahead of
 * it, registered once, before any of the host's effects, and stops a call it
 * takes from reaching it.
 */
import { host } from "../shared/host";
import { toMessage } from "../../../src/app-utils";
import { runAgentTool, toolError } from "../../../src/agent/agent-protocol";
import { executeAgentCanvasToolRequest, parseAgentCanvasToolRequest } from "../../../src/agent/agent-canvas-tools";
import { executeAgentSpreadsheetToolRequest, parseAgentSpreadsheetToolRequest } from "../../../src/agent/agent-spreadsheet-tools";
import {
  LATTICE_PRESENTATION_TOOL_RESULT, executeAgentPresentationToolRequest, parseAgentPresentationToolRequest,
} from "../../../src/agent/agent-presentation-tools";
import type { AgentProjectDocumentToolRequest } from "../../../src/agent/agent-project-document-tools";

type Family = "canvas" | "spreadsheet" | "presentation";

type Route = {
  family: Family;
  parse: (data: unknown) => { id: string } | null;
  /** The Tauri executor, run here when no open document holds the call. */
  local: (request: never, projectRoot: string | null) => Promise<object>;
  /** The result envelope's type and fallback code, for a call that fails before one exists. */
  resultType: string;
  failure: string;
};

// The canvas and spreadsheet result types are private to their modules;
// these are the strings they send (`agent-canvas-tools.ts`,
// `agent-spreadsheet-tools.ts`), which the frame matches.
const ROUTES: readonly Route[] = [
  {
    family: "canvas",
    parse: parseAgentCanvasToolRequest,
    local: executeAgentCanvasToolRequest as Route["local"],
    resultType: "lattice:canvas-tool-result",
    failure: "canvas_tool_failed",
  },
  {
    family: "spreadsheet",
    parse: parseAgentSpreadsheetToolRequest,
    local: executeAgentSpreadsheetToolRequest as Route["local"],
    resultType: "lattice:spreadsheet-tool-result",
    failure: "spreadsheet_tool_failed",
  },
  {
    family: "presentation",
    parse: parseAgentPresentationToolRequest,
    local: executeAgentPresentationToolRequest as Route["local"],
    resultType: LATTICE_PRESENTATION_TOOL_RESULT,
    failure: "presentation_preview_failed",
  },
];

/** The route a frame message is a well-formed call of, as the host's routes parse it. */
export function documentToolRoute(data: unknown): { route: Route; request: { id: string } } | null {
  for (const route of ROUTES) {
    const request = route.parse(data);
    if (request) return { route, request };
  }
  return null;
}

type OwnerAnswer = { result?: object; local?: boolean };

/**
 * Run `request` where its document is: the owner's open document, else
 * here. A failure on the way (the document closed mid-call) is the call's
 * error, never a second run elsewhere, which could apply it twice.
 */
export async function runDocumentTool(
  route: Route,
  request: { id: string },
  projectRoot: string | null,
  ask: (family: Family, request: object) => Promise<OwnerAnswer> = (family, payload) =>
    host().request<OwnerAnswer>("agent:document-tool", { family, request: payload }),
): Promise<object> {
  let answer: OwnerAnswer;
  try {
    answer = await ask(route.family, request);
  } catch (error) {
    return runAgentTool(route.resultType, request.id, route.failure, () => {
      throw toolError(toMessage(error), route.failure);
    }, false);
  }
  if (answer.result) return answer.result;
  return route.local(request as never, projectRoot);
}

/** Where the listener posts its answers: the Agent frame of the current page. */
type Target = {
  frame: () => Window | null;
  origin: string | null;
  projectRoot: string | null;
  post: (message: object) => void;
};

let target: Target | null = null;

/** The Agent surface's frame takes calls now (`null`: none does). */
export function setDocumentToolTarget(next: Target | null) {
  target = next;
}

// Registered at load, so ahead of the host's own listener (listeners on the
// window run in the order they were added).
window.addEventListener("message", (event) => {
  const current = target;
  if (!current?.origin || event.origin !== current.origin || event.source !== current.frame()) return;
  const routed = documentToolRoute(event.data);
  if (!routed) return;
  event.stopImmediatePropagation();
  void runDocumentTool(routed.route, routed.request, current.projectRoot).then((result) => {
    // The page moved on to another frame meanwhile: this one is gone.
    if (target === current) current.post(result);
  });
}, true);

/**
 * The host bridge's `projectDocumentCreator`: the owner creates the board or
 * sheet as the Project pane does, opens it, and answers with its path once
 * its editor has registered (`createAgentProjectDocument`).
 */
export function createProjectDocument(request: AgentProjectDocumentToolRequest): Promise<string> {
  return host().request<string>("agent:create-document", {
    path: request.args.path,
    documentType: request.args.documentType,
    expiresAt: request.expiresAt,
  });
}
