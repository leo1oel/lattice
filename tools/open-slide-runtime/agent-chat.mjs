// Since 2.3.0 Open Slide ships its own agent chat, which drives a locally
// installed Claude Code or Codex CLI from the dev server. Lattice's agent panel
// already edits decks, so the embedded editor offers no second chat.
import { moduleFilePath, requireContract } from "./patch-contract.mjs";

/**
 * The Open Slide config the runtime starts with. Turning the agent off answers
 * /__agent/status as disabled and refuses every other agent route, so the
 * runtime never spawns an agent CLI or installs its SDK into the shadow
 * workspace.
 */
export const OPEN_SLIDE_CONFIG = { agent: { enabled: false } };

export function transformOpenSlideAgentEntryPoints(source, id) {
  const modulePath = moduleFilePath(id);
  // With its routes off, the panel could only report itself disabled. The
  // rest of upstream's agent wiring stays inert: it activates only for a
  // connected provider, and none ever connects.
  const removals = modulePath.endsWith("/@open-slide/core/src/app/routes/slide.tsx")
    ? [
      `      } else if (import.meta.env.DEV && (e.key === 'a' || e.key === 'A')) {
        toggleAgent();
`,
      `                      {narrowToolbar && import.meta.env.DEV && (
                        <DropdownMenuItem onClick={toggleAgent}>
                          <Sparkles />
                          {t.agent.openTitle}
                        </DropdownMenuItem>
                      )}
`,
      "              {import.meta.env.DEV && view === 'slides' && !narrowToolbar && <AgentToggleButton />}\n",
    ]
    : modulePath.endsWith("/@open-slide/core/src/app/components/command/slide-command-menu.tsx")
      ? [
        `      deck.push({
        id: 'agent-panel',
        label: t.agent.openTitle,
        icon: <Sparkles />,
        keywords: ['agent', 'claude', 'codex', 'chat', 'ai'],
        shortcut: 'A',
        run: handlers.onToggleAgentPanel,
      });
`,
      ]
      : null;
  if (!removals) return null;
  requireContract(source, removals, "agent panel entry points");
  return removals.reduce((transformed, removal) => transformed.replace(removal, ""), source);
}
