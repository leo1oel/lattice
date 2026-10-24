// Open Slide 2.3 lights up a deck while its own agent writes it: a glow and a
// sweep on every reload, a pill naming the agent and its current tool, and a
// jump to each new page (upstream `useAgentActivity` and `AgentPresence`).
// Lattice turns its own agent off, so the host forwards the Lattice agent
// panel's turn here instead (src/editor/presentation/open-slide-agent-presence.ts)
// and the runtime pushes it to every page it serves.
import { REQUEST_LATTICE_AGENT } from "./agent-chat.mjs";
import { moduleFilePath, requireContract } from "./patch-contract.mjs";

const ACTIVITY_EVENT = "lattice:agent-activity";
const ACTIVITY_REQUEST_EVENT = "lattice:agent-activity-request";
const ACTIVITY_BODY_LIMIT = 16 * 1024;
const MAX_DECKS = 32;
// The deck folder names deckIdFromOpenSlidePath (src/app-utils.ts) accepts.
const DECK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * The presence a page shows for the host's turn: upstream's `AgentActivity`,
 * plus the decks the turn has named. Anything but a live turn that names a
 * deck clears it.
 */
export function normalizeAgentActivity(value) {
  if (!value || typeof value !== "object") return null;
  const { state, provider, tool, decks } = value;
  if (state !== "running" && state !== "waiting") return null;
  const named = Array.isArray(decks)
    ? [...new Set(decks.filter((deck) => typeof deck === "string" && DECK_ID_RE.test(deck)))].slice(0, MAX_DECKS)
    : [];
  if (!named.length) return null;
  // Upstream shows a tool only while one runs; a pending question replaces it.
  const title = state === "running" ? text(tool?.title, 200) : "";
  return {
    provider: text(provider?.id, 64),
    label: text(provider?.label, 80) || "Lattice AI",
    phase: state === "waiting" ? "waiting" : title ? "tool" : "thinking",
    title: title || null,
    detail: (title && text(tool?.detail, 500)) || null,
    decks: named,
  };
}

/**
 * The latest presence and the two ends that move it: the host's POST to
 * `/__lattice/agent-activity` and a Vite custom event to the pages. A page
 * that loads mid-turn asks for the presence it missed.
 */
export function createAgentActivityChannel() {
  let activity = null;
  let ws = null;
  return {
    plugin: {
      name: "lattice:agent-activity",
      apply: "serve",
      configureServer(viteServer) {
        ws = viteServer.ws;
        ws.on(ACTIVITY_REQUEST_EVENT, (_data, client) => client.send(ACTIVITY_EVENT, { activity }));
      },
    },
    async receive(req, res) {
      const cors = { "access-control-allow-origin": "*" };
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > ACTIVITY_BODY_LIMIT) throw new Error("Agent activity is too large");
          chunks.push(chunk);
        }
        activity = normalizeAgentActivity(JSON.parse(Buffer.concat(chunks)).activity);
        ws?.send(ACTIVITY_EVENT, { activity });
        res.writeHead(204, cors).end();
      } catch (error) {
        res.writeHead(400, cors).end(String(error.message));
      }
    },
  };
}

// Replaces upstream's session-derived activity; nothing else in the editor
// reads Open Slide's own sessions, which never exist in Lattice.
const LATTICE_ACTIVITY_STORE = `
type LatticeAgentActivity = Omit<AgentActivity, 'slideId'> & { decks: string[] };
let latticeAgentActivity: LatticeAgentActivity | null = null;
const latticeAgentListeners = new Set<() => void>();
function setLatticeAgentActivity(next: LatticeAgentActivity | null) {
  latticeAgentActivity = next;
  for (const listener of latticeAgentListeners) listener();
}
function subscribeLatticeAgentActivity(listener: () => void) {
  latticeAgentListeners.add(listener);
  return () => {
    latticeAgentListeners.delete(listener);
  };
}
function readLatticeAgentActivity() {
  return latticeAgentActivity;
}
if (import.meta.hot) {
  import.meta.hot.on('${ACTIVITY_EVENT}', (data: { activity?: LatticeAgentActivity | null }) => {
    setLatticeAgentActivity(data?.activity ?? null);
  });
  // The host can no longer clear a turn this page is cut off from.
  import.meta.hot.on('vite:ws:disconnect', () => setLatticeAgentActivity(null));
  import.meta.hot.send('${ACTIVITY_REQUEST_EVENT}');
}
`;

/** Each module's verbatim upstream fragments and their Lattice replacements. */
function agentPresencePatches(modulePath) {
  if (modulePath.endsWith("/@open-slide/core/src/app/lib/agent/use-agent.ts")) {
    return [
      [
        "import { useCallback, useEffect, useSyncExternalStore } from 'react';\n",
        "import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';\n",
      ],
      [
        `export type AgentActivity = {
  provider: AgentProviderId;
`,
        `export type AgentActivity = {
  /** The Lattice panel's provider id; the presence colors key on \`codex\`. */
  provider: string;
  /** The provider's name, for the presence pill. */
  label: string;
  /** The deck the presence is drawn on. */
  slideId: string;
`,
      ],
      [
        `export function useAgentActivity(slideId: string): AgentActivity | null {
  const { sessions } = useAgentSessions();
  const summary = sessions.find((s) => s.slideId === slideId && s.status === 'running') ?? null;
  const session = useAgentSession(summary?.id ?? null);
  if (!summary) return null;
  const items = session?.items ?? [];
  const waiting = items.some(
    (i) => (i.kind === 'question' || i.kind === 'permission') && i.status === 'pending',
  );
  if (waiting) return { provider: summary.provider, phase: 'waiting', title: null, detail: null };
  const last = items.at(-1);
  if (last?.kind === 'tool' && last.status === 'running') {
    return { provider: summary.provider, phase: 'tool', title: last.title, detail: last.detail };
  }
  return { provider: summary.provider, phase: 'thinking', title: null, detail: null };
}
`,
        `export function useAgentActivity(slideId: string): AgentActivity | null {
  const activity = useSyncExternalStore(subscribeLatticeAgentActivity, readLatticeAgentActivity);
  // Only a deck the turn names lights up, so the editor never follows a
  // turn to new pages of a deck it is not writing.
  return useMemo(() => {
    if (!activity?.decks.includes(slideId)) return null;
    const { decks: _decks, ...shown } = activity;
    return { ...shown, slideId };
  }, [activity, slideId]);
}
`,
      ],
    ];
  }
  if (modulePath.endsWith("/@open-slide/core/src/app/components/agent/agent-presence.tsx")) {
    // The pill names the Lattice panel's provider and opens that panel.
    return [
      [
        "import { type AgentActivity, setDockOpen, useAgentState } from '@/lib/agent/use-agent';\n",
        "import type { AgentActivity } from '@/lib/agent/use-agent';\n",
      ],
      ["import { ProviderLogo } from './provider-logo';\n", ""],
      [
        `  const { status } = useAgentState();
  const name = status?.providers.find((p) => p.id === activity.provider)?.name ?? '';
`,
        "",
      ],
      // Marked as editor chrome: the inspector swallows every other click on the canvas.
      ["      onClick={() => setDockOpen(true)}\n", "      data-inspector-ui\n      onClick={() => requestLatticeAgent('open', activity.slideId)}\n"],
      [
        `      <ProviderLogo provider={activity.provider} className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">
        {format(t.agent.presenceEditing, { provider: name })}
      </span>`,
        // Tailwind generates only the classes upstream's own source uses, so
        // the cap that leaves the current tool room is an inline style.
        `      <span className="shrink-0 truncate font-medium" style={{ maxWidth: '70%' }}>
        {format(t.agent.presenceEditing, { provider: activity.label })}
      </span>`,
      ],
    ];
  }
  return null;
}

export function transformOpenSlideAgentPresence(source, id) {
  const modulePath = moduleFilePath(id);
  const patches = agentPresencePatches(modulePath);
  if (!patches) return null;
  requireContract(source, patches.map(([before]) => before), "agent presence");
  const transformed = patches.reduce((next, [before, after]) => next.replace(before, after), source);
  return transformed + (modulePath.endsWith("/use-agent.ts") ? LATTICE_ACTIVITY_STORE : REQUEST_LATTICE_AGENT);
}
