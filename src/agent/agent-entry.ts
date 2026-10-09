/**
 * The controls that open or reveal the Agent. Opening it is how a selection
 * made elsewhere reaches its composer as context, so a press on one is not the
 * outside click that dismisses that selection (see pdf-text-layer-selection).
 *
 * Lattice's own controls carry the attribute. The Agent's workspace tab is
 * drawn by Trellis itself, so it is recognised by the view id the controller
 * opens the Agent under.
 */
/* eslint-disable lingui/no-unlocalized-strings -- DOM attribute and selector only. */

export const AGENT_ENTRY_ATTRIBUTE = "data-agent-entry";

const AGENT_ENTRY_SELECTOR = `[${AGENT_ENTRY_ATTRIBUTE}], [data-trellis-part="tab"][data-view="agent"]`;

/** Props for a control that opens or reveals the Agent. */
export const agentEntryProps = { [AGENT_ENTRY_ATTRIBUTE]: "" } as const;

export function isAgentEntryTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(AGENT_ENTRY_SELECTOR));
}
