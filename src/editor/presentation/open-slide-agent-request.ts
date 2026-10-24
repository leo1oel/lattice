// What the Open Slide editor asks of Lattice's agent panel: the runtime's
// patched entry points (tools/open-slide-runtime/agent-chat.mjs) post
// `lattice:agent-request` to the embedding page when the user clicks one.
import { isRecord } from "../../app-utils";

const OPEN_SLIDE_AGENT_REQUEST = "lattice:agent-request";
const KINDS = ["apply-comments", "draft-deck", "open"] as const;

export type OpenSlideAgentRequest = {
  /**
   * `apply-comments`: apply the deck's pending comments now. `draft-deck`:
   * start a brief for a new deck. `open`: just focus the composer.
   */
  kind: (typeof KINDS)[number];
  /** The project-relative deck entry the request came from; null from the home screen. */
  deckPath: string | null;
};

/**
 * The request in `data` when it is well formed and concerns `deckId`, the
 * deck this frame was opened on. Only a draft-deck request, sent from the
 * home screen, names no deck; one for any other deck the user navigated to
 * inside the frame is dropped, since the agent's context describes this one.
 */
export function parseOpenSlideAgentRequest(data: unknown, deckId: string): { kind: OpenSlideAgentRequest["kind"]; nonce: string } | null {
  if (!isRecord(data) || data.type !== OPEN_SLIDE_AGENT_REQUEST || data.version !== 1) return null;
  const { kind, slideId, nonce } = data;
  if (!KINDS.includes(kind as OpenSlideAgentRequest["kind"])) return null;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) return null;
  if (kind !== "draft-deck" && slideId !== deckId) return null;
  return { kind: kind as OpenSlideAgentRequest["kind"], nonce };
}
