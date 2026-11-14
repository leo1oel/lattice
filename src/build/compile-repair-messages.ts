import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

// Status and error text the compile-repair relay reports: the Synara
// compile-repair route (latticeCompileRepairHttpRoute.ts upstream) and the Rust
// relay in synara/task_relay.rs. Keyed by their exact English.
const RELAY_MESSAGES: Record<string, MessageDescriptor> = {
  "The repair agent needs an answer. Open the repair thread to respond.": msg`The repair agent needs an answer. Open the repair thread to respond.`,
  "Cancellation requested; waiting for the provider to stop.": msg`Cancellation requested; waiting for the provider to stop.`,
  "Repair has no active turn.": msg`Repair has no active turn.`,
  "The agent service is unavailable.": msg`The agent service is unavailable.`,
  "The built-in agent is off on this platform until Lattice can keep it from editing bibliography (.bib) files directly.": msg`The built-in agent is off on this platform until Lattice can keep it from editing bibliography (.bib) files directly.`,
  // The Linux guard's own reasons (synara/bibliography_guard/linux.rs).
  "The built-in agent is off because bubblewrap (bwrap) is not installed. Lattice runs the agent inside it to keep it from editing bibliography (.bib) files directly.": msg`The built-in agent is off because bubblewrap (bwrap) is not installed. Lattice runs the agent inside it to keep it from editing bibliography (.bib) files directly.`,
  "The built-in agent is off because FUSE (fusermount3 and /dev/fuse) is not available. Lattice needs it to keep the agent from editing bibliography (.bib) files directly.": msg`The built-in agent is off because FUSE (fusermount3 and /dev/fuse) is not available. Lattice needs it to keep the agent from editing bibliography (.bib) files directly.`,
  "The built-in agent is off because this system does not let bubblewrap start a sandbox (unprivileged user namespaces are restricted). Lattice runs the agent inside one to keep it from editing bibliography (.bib) files directly.": msg`The built-in agent is off because this system does not let bubblewrap start a sandbox (unprivileged user namespaces are restricted). Lattice runs the agent inside one to keep it from editing bibliography (.bib) files directly.`,
  "The built-in agent is off for this project: Lattice cannot keep the agent from editing bibliography (.bib) files everywhere in its folder. The agent can write to /tmp and to the hidden folders in your home folder directly, so a bibliography in one of those is not protected while the agent works on any project. Move this project to an ordinary folder to use the agent with it.": msg`The built-in agent is off for this project: Lattice cannot keep the agent from editing bibliography (.bib) files everywhere in its folder. The agent can write to /tmp and to the hidden folders in your home folder directly, so a bibliography in one of those is not protected while the agent works on any project. Move this project to an ordinary folder to use the agent with it.`,
  "The repair request failed.": msg`The repair request failed.`,
};

/* eslint-disable lingui/no-unlocalized-strings -- patterns matched in relay text */
const ERROR_PREFIX = "Error: ";
const TURN_ENDED = /^Repair turn (\S+)\.$/;
const PROVIDER_STOPPED = /^Repair provider (\S+)\.$/;
const SERVICE_STATUS = /^Repair service returned (.+)\.$/;
/* eslint-enable lingui/no-unlocalized-strings */

/**
 * A compile-repair status line in the interface language. Relay text Lattice
 * does not know (a provider's own error) is shown as reported.
 */
export function compileRepairMessage(message: string): string {
  // A failed repair arrives as `String(new Error(relayMessage))`.
  const body = message.startsWith(ERROR_PREFIX) ? message.slice(ERROR_PREFIX.length) : message;
  const known = RELAY_MESSAGES[body];
  if (known) return i18n._(known);
  const turn = TURN_ENDED.exec(body)?.[1];
  if (turn) return i18n._(msg`Repair turn ${turn}.`);
  const provider = PROVIDER_STOPPED.exec(body)?.[1];
  if (provider) return i18n._(msg`Repair provider ${provider}.`);
  const status = SERVICE_STATUS.exec(body)?.[1];
  if (status) return i18n._(msg`Repair service returned ${status}.`);
  return message;
}
