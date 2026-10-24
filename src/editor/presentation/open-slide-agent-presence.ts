// The agent panel's live turn, forwarded to the Open Slide runtime so its
// pages draw upstream's presence: the glow, the pill and the follow-along
// (tools/open-slide-runtime/agent-presence.mjs). Each page shows it only on
// a deck the turn names.
import { agentDeckPresence, subscribeAgentDeckPresence } from "../../agent/agent-turn-activity";

type Forwarder = { users: number; stop: () => void };

// Every deck of a project shares its runtime, so one forwarder serves them all.
const forwarders = new Map<string, Forwarder>();

/** The presence a runtime serving `projectRoot` shows: another project's turn is none. */
function runtimeActivity(projectRoot: string) {
  const presence = agentDeckPresence();
  if (presence?.workspaceRoot !== projectRoot) return null;
  const { state, provider, tool, decks } = presence;
  return { state, provider, tool, decks };
}

function startForwarder(projectRoot: string, origin: string, controlToken: string): Forwarder {
  let sending = false;
  let changed = true;
  let stopped = false;
  // One request at a time, always with the latest presence, so a slow one
  // never lands after the report that superseded it.
  const flush = async () => {
    if (sending) return;
    sending = true;
    while (changed && !stopped) {
      changed = false;
      /* eslint-disable lingui/no-unlocalized-strings -- loopback bridge route and headers */
      await fetch(`${origin}/__lattice/agent-activity`, {
        method: "POST",
        headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ activity: runtimeActivity(projectRoot) }),
      }).catch(() => undefined);
      /* eslint-enable lingui/no-unlocalized-strings */
    }
    sending = false;
  };
  const unsubscribe = subscribeAgentDeckPresence(() => {
    changed = true;
    void flush();
  });
  // A runtime that started mid-turn, or kept a previous page's turn, catches up.
  void flush();
  return {
    users: 0,
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}

/** Keep the runtime at `origin` showing the panel's turn until the returned stop is called. */
export function forwardAgentPresence(projectRoot: string, origin: string, controlToken: string): () => void {
  const key = `${projectRoot}\n${origin}\n${controlToken}`;
  const forwarder = forwarders.get(key) ?? startForwarder(projectRoot, origin, controlToken);
  forwarders.set(key, forwarder);
  forwarder.users += 1;
  return () => {
    forwarder.users -= 1;
    if (forwarder.users > 0) return;
    forwarder.stop();
    forwarders.delete(key);
  };
}
