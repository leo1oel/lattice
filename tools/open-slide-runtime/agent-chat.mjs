// Since 2.3.0 Open Slide ships its own agent chat, which drives a locally
// installed Claude Code or Codex CLI from the dev server. Lattice's agent panel
// already edits decks, so the embedded editor offers no second chat: its entry
// points ask the Lattice host to open that panel instead.
import { moduleFilePath, requireContract } from "./patch-contract.mjs";

/**
 * The Open Slide config the runtime starts with. Turning the agent off answers
 * /__agent/status as disabled and refuses every other agent route, so the
 * runtime never spawns an agent CLI or installs its SDK into the shadow
 * workspace.
 */
export const OPEN_SLIDE_CONFIG = { agent: { enabled: false } };

/** The provider name upstream's "Apply with {provider}" copy is formatted with. */
const LATTICE_AGENT_NAME = "'Lattice AI'";

// A one-shot user action, so it goes straight to the embedding page rather
// than over the runtime's replayable event stream. Nothing in it is secret:
// the host accepts it only from this deck's frame and the runtime's origin
// (src/editor/presentation/open-slide-agent-request.ts), and drops a nonce it
// has already seen.
const REQUEST_LATTICE_AGENT = `
function requestLatticeAgent(kind: 'apply-comments' | 'draft-deck' | 'open', slideId = '') {
  const nonce = \`\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2)}\`;
  window.parent.postMessage({ type: 'lattice:agent-request', version: 1, kind, slideId, nonce }, '*');
}
`;

/** Each module's verbatim upstream fragments and their Lattice replacements. */
function agentEntryPointPatches(modulePath) {
  if (modulePath.endsWith("/@open-slide/core/src/app/routes/slide.tsx")) {
    // The toolbar button and the narrow More menu item stay gone: Lattice's
    // own chrome toggles its panel. The shortcut and the command menu entry
    // (whose label is the patched `openTitle` copy) ask for it from the canvas.
    return [
      [
        `      } else if (import.meta.env.DEV && (e.key === 'a' || e.key === 'A')) {
        toggleAgent();
`,
        `      } else if (import.meta.env.DEV && (e.key === 'a' || e.key === 'A')) {
        requestLatticeAgent('open', slideId);
`,
      ],
      [
        `                      {narrowToolbar && import.meta.env.DEV && (
                        <DropdownMenuItem onClick={toggleAgent}>
                          <Sparkles />
                          {t.agent.openTitle}
                        </DropdownMenuItem>
                      )}
`,
        "",
      ],
      ["              {import.meta.env.DEV && view === 'slides' && !narrowToolbar && <AgentToggleButton />}\n", ""],
      ["                onToggleAgentPanel: toggleAgent,\n", "                onToggleAgentPanel: () => requestLatticeAgent('open', slideId),\n"],
    ];
  }
  if (modulePath.endsWith("/@open-slide/core/src/app/components/inspector/comment-layer.tsx")) {
    // The branch for a deck with comments and no connected Open Slide agent,
    // which is always the one Lattice shows.
    return [[
      `              {t.inspector.commentsApplyHintPrefix}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                /apply-comments
              </code>
              {t.inspector.commentsApplyHintSuffix}`,
      `              <button
                type="button"
                className="pointer-events-auto rounded-[4px] px-1 py-0.5 font-medium text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30"
                onClick={() => requestLatticeAgent('apply-comments', slideId)}
              >
                {format(t.agent.applyCommentsWith, { provider: ${LATTICE_AGENT_NAME} })}
              </button>`,
    ]];
  }
  if (modulePath.endsWith("/@open-slide/core/src/app/routes/home.tsx")) {
    // Upstream's `/create-slide` hint names a command Lattice's composer does
    // not have. The button only fills the composer; the user finishes the
    // brief and sends it.
    return [
      ["  FolderPlus,\n", "  FolderPlus,\n  Sparkles,\n"],
      [
        `              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                {t.home.createSlideHintPrefix}
                <code className="rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
                  /create-slide
                </code>
                {t.home.createSlideHintSuffix}
              </p>`,
        `              <Button
                size="sm"
                className="mt-4 h-auto min-h-7 max-w-full py-1 whitespace-normal"
                onClick={() => requestLatticeAgent('draft-deck')}
              >
                <Sparkles />
                {format(t.agent.createDeckWith, { provider: ${LATTICE_AGENT_NAME} })}
              </Button>`,
      ],
    ];
  }
  return null;
}

export function transformOpenSlideAgentEntryPoints(source, id) {
  // With its routes off, Open Slide's own panel could only report itself
  // disabled. The rest of upstream's agent wiring stays inert: it activates
  // only for a connected provider, and none ever connects.
  const patches = agentEntryPointPatches(moduleFilePath(id));
  if (!patches) return null;
  requireContract(source, patches.map(([before]) => before), "agent panel entry points");
  return patches.reduce((transformed, [before, after]) => transformed.replace(before, after), source)
    + REQUEST_LATTICE_AGENT;
}
