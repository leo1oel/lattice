/**
 * The one pass a build pipeline keeps queued behind the build that holds it.
 * Every request made meanwhile folds into it: one more pass covers them all.
 */

/** A build asked for while another runs; `force: null` means nothing is queued. */
export type QueuedBuild = { force: boolean | null; sound: boolean; requested: boolean; consumeAgentAssociations: boolean; clean: boolean };
export const IDLE_QUEUE: QueuedBuild = { force: null, sound: false, requested: false, consumeAgentAssociations: false, clean: false };

/** Fold a request into the queued pass; any request asking for something gets it. */
export function enqueueBuild(
  queue: QueuedBuild,
  force: boolean,
  options: { sound?: boolean; requested?: boolean; consumeAgentAssociations?: boolean; clean?: boolean } | undefined,
) {
  queue.force = (queue.force ?? false) || force;
  queue.sound ||= options?.sound === true;
  queue.requested ||= options?.requested === true;
  queue.consumeAgentAssociations ||= options?.consumeAgentAssociations === true;
  // Cleaning waits for the running pass: never delete files out from under it.
  queue.clean ||= options?.clean === true;
}
