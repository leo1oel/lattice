// A prompt the host puts into the agent panel's composer, and the panel's
// answer. The panel validates the message in Synara's embedMode.ts: the field
// names, the outcomes and the error codes are part of that wire contract.
import { msg } from "@lingui/core/macro";
import { isRecord } from "../app-utils";
import type { OpenSlideAgentRequest } from "../editor/presentation/open-slide-agent-request";
import { i18n } from "../i18n";

const LATTICE_COMPOSER_PROMPT = "lattice:composer-prompt";
export const SYNARA_COMPOSER_PROMPT_RESULT = "synara:composer-prompt-result";
/** The panel rejects a longer prompt. */
const MAX_COMPOSER_PROMPT_LENGTH = 4_000;

export interface AgentComposerPromptMessage {
  type: typeof LATTICE_COMPOSER_PROMPT;
  version: 1;
  /** Echoed back in the result. */
  requestId: string;
  /** The panel refuses a prompt for a workspace other than its own. */
  workspaceRoot: string;
  /** Already localized. An empty draft only focuses the composer. */
  text: string;
  /**
   * `draft` fills the composer and never sends. `send` is the user pressing
   * Send in the panel's active conversation, queued behind a live turn; with a
   * question or approval pending it falls back to a draft.
   */
  mode: "draft" | "send";
}

function buildAgentComposerPromptMessage(
  { workspaceRoot, text, mode }: Pick<AgentComposerPromptMessage, "workspaceRoot" | "text" | "mode">,
): AgentComposerPromptMessage {
  return {
    type: LATTICE_COMPOSER_PROMPT,
    version: 1,
    requestId: crypto.randomUUID(),
    workspaceRoot,
    text: text.slice(0, MAX_COMPOSER_PROMPT_LENGTH),
    mode,
  };
}

/**
 * What an Open Slide entry point asks the panel for. The deck's pending
 * comments are not repeated here: they reach the agent in the presentation
 * host context sent with the message, as for a typed one.
 */
export function openSlideComposerPrompt(
  { kind, deckPath }: OpenSlideAgentRequest,
  workspaceRoot: string,
): AgentComposerPromptMessage {
  if (kind === "apply-comments") {
    const deck = deckPath ?? "";
    return buildAgentComposerPromptMessage({ workspaceRoot, mode: "send", text: i18n._(msg`Apply the pending comments in ${deck}.`) });
  }
  // The user finishes the brief, so the draft ends where they type.
  const text = kind === "draft-deck" ? `${i18n._(msg`Create a presentation about`)} ` : "";
  return buildAgentComposerPromptMessage({ workspaceRoot, mode: "draft", text });
}

const RESULT_OUTCOMES = ["drafted", "sent", "queued"] as const;
const RESULT_ERROR_CODES = ["invalid", "workspace-mismatch", "no-provider", "awaiting-input", "send-failed"] as const;

export type AgentComposerPromptResult = {
  requestId: string;
  ok: boolean;
  outcome?: (typeof RESULT_OUTCOMES)[number];
  threadId?: string;
  error?: { code: (typeof RESULT_ERROR_CODES)[number]; message: string };
};

const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.includes(value as T);

export function parseAgentComposerPromptResult(value: unknown): AgentComposerPromptResult | null {
  if (!isRecord(value) || value.type !== SYNARA_COMPOSER_PROMPT_RESULT || value.version !== 1) return null;
  const { requestId, ok, outcome, threadId, error } = value;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128 || typeof ok !== "boolean") return null;
  const result: AgentComposerPromptResult = { requestId, ok };
  if (includes(RESULT_OUTCOMES, outcome)) result.outcome = outcome;
  if (typeof threadId === "string" && threadId) result.threadId = threadId;
  if (isRecord(error) && includes(RESULT_ERROR_CODES, error.code)) {
    result.error = { code: error.code, message: typeof error.message === "string" ? error.message.slice(0, 1_000) : "" };
  }
  return result;
}
