// The agent panel's turn as the panel reports it, and the presence an Open
// Slide deck shows for it. Synara posts `synara:turn-activity` from its
// embedMode.ts on every turn state change and tool start and end: the field
// names and states are that wire contract.
import { deckIdFromOpenSlidePath, isRecord } from "../app-utils";
import { boundedString, isWorkspaceRelativePath } from "./agent-protocol";

export const SYNARA_TURN_ACTIVITY = "synara:turn-activity";
const STATES = ["running", "waiting", "idle"] as const;
const MAX_TOOL_PATHS = 64;
// Open Slide's deck folder, the part of `slides/<id>/index.tsx` a path inside it shares.
const DECK_FOLDER = /^slides\/([a-z0-9]+(?:-[a-z0-9]+)*)\//i;

export type AgentTurnActivity = {
  workspaceRoot: string;
  threadId: string;
  turnId: string | null;
  /** `waiting`: blocked on an approval or a question. `idle`: no live turn in the panel's thread. */
  state: (typeof STATES)[number];
  provider: { id: string; label: string };
  /** The tool call in flight; absent between tools. Paths are project-relative. */
  tool?: { title: string; detail: string | null; paths: string[] };
};

export function parseAgentTurnActivity(value: unknown): AgentTurnActivity | null {
  if (!isRecord(value) || value.type !== SYNARA_TURN_ACTIVITY || value.version !== 1) return null;
  const { workspaceRoot, threadId, turnId, state, provider, tool } = value;
  if (typeof workspaceRoot !== "string" || !workspaceRoot) return null;
  const thread = boundedString(threadId, 128);
  if (!thread || !STATES.includes(state as AgentTurnActivity["state"])) return null;
  if (turnId !== null && (typeof turnId !== "string" || !turnId || turnId.length > 128)) return null;
  if (!isRecord(provider)) return null;
  const activity: AgentTurnActivity = {
    workspaceRoot,
    threadId: thread,
    turnId,
    state: state as AgentTurnActivity["state"],
    provider: { id: boundedString(provider.id, 64, true) ?? "", label: boundedString(provider.label, 80, true) ?? "" },
  };
  const title = isRecord(tool) ? boundedString(tool.title, 200) : null;
  if (isRecord(tool) && title) {
    const paths = Array.isArray(tool.paths) ? tool.paths.slice(0, MAX_TOOL_PATHS) : [];
    activity.tool = {
      title,
      detail: boundedString(tool.detail, 500),
      paths: paths.filter((path): path is string => isWorkspaceRelativePath(path)),
    };
  }
  return activity;
}

/** What an Open Slide deck shows of the panel's live turn. */
export type AgentDeckPresence = {
  workspaceRoot: string;
  threadId: string;
  turnId: string | null;
  state: "running" | "waiting";
  provider: AgentTurnActivity["provider"];
  tool: { title: string; detail: string | null } | null;
  /**
   * Every deck the turn has named so far: the deck open when it started (the
   * one its sent context described) and each deck a tool's paths entered.
   */
  decks: string[];
};

/**
 * Fold one report into the turn's presence. A turn keeps the decks it has
 * named until it ends, so the presence holds between tools; another thread
 * or turn starts over from `contextDeck`, the deck open as it started.
 */
export function nextAgentDeckPresence(
  previous: AgentDeckPresence | null,
  activity: AgentTurnActivity,
  contextDeck: string | null,
): AgentDeckPresence | null {
  if (activity.state === "idle") return null;
  // A turn may be reported before the panel knows its id.
  const sameTurn = previous !== null && previous.threadId === activity.threadId
    && (previous.turnId === activity.turnId || previous.turnId === null || activity.turnId === null);
  const decks = new Set(sameTurn ? previous.decks : contextDeck ? [contextDeck] : []);
  for (const path of activity.tool?.paths ?? []) {
    const deck = DECK_FOLDER.exec(path)?.[1];
    if (deck) decks.add(deck);
  }
  const { tool } = activity;
  return {
    workspaceRoot: activity.workspaceRoot,
    threadId: activity.threadId,
    turnId: activity.turnId ?? (sameTurn ? previous.turnId : null),
    state: activity.state,
    provider: activity.provider,
    tool: tool ? { title: tool.title, detail: tool.detail } : null,
    decks: [...decks],
  };
}

/** The deck open in the context the panel was last given, when it is in `workspaceRoot`. */
export function contextDeck(context: { workspaceRoot: string; presentation?: { pagePath: string } } | null, workspaceRoot: string) {
  return context?.workspaceRoot === workspaceRoot && context.presentation
    ? deckIdFromOpenSlidePath(context.presentation.pagePath)
    : null;
}

// One window has one agent panel, so its turn's presence is window state.
let presence: AgentDeckPresence | null = null;
const listeners = new Set<() => void>();

export function agentDeckPresence(): AgentDeckPresence | null {
  return presence;
}

export function publishAgentDeckPresence(next: AgentDeckPresence | null) {
  if (next === presence) return;
  presence = next;
  for (const listener of listeners) listener();
}

export function subscribeAgentDeckPresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
