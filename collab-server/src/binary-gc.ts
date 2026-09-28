import { binaryKey, bumpRoots, type CoordinatorState } from "./coordinator-model";
import { logEvent } from "./runtime";

export type BinaryGcResult = { scanned: number; deleted: number; orphanBacklog: number; round: 1 | 2; truncated?: boolean; waitingForGrace?: boolean };
type SweepIo = { bucket: R2Bucket; persist(): Promise<void>; scheduleRetry(attempts: number): Promise<void> };

/** Every R2 key the project may still need: live references, conflict losers, unexpired retention roots and uncommitted uploads. */
function gcRoots(state: CoordinatorState, now: number): Set<string> {
  const roots = new Set<string>();
  for (const reference of Object.values(state.binaryReferences ?? {})) roots.add(binaryKey(state.projectInstanceId, reference.fileId, reference.hash));
  for (const conflict of state.binaryConflicts ?? []) roots.add(binaryKey(state.projectInstanceId, conflict.fileId, conflict.loser.hash));
  const retained = (state.binaryRetentionRoots ?? []).filter((root) => root.expiresAt > now);
  if (retained.length !== (state.binaryRetentionRoots ?? []).length) { state.binaryRetentionRoots = retained; bumpRoots(state); }
  for (const root of retained) roots.add(root.key);
  for (const ticket of state.binaryTickets ?? []) {
    if (ticket.claims.kind === "binary-upload" && ticket.uploaded && ticket.claims.expiresAt > now && !state.operations[ticket.claims.operationId]) roots.add(binaryKey(state.projectInstanceId, ticket.claims.fileId, ticket.claims.declaredHash));
  }
  return roots;
}

/**
 * One page of the durable double sweep over the project's R2 prefix. Round 1
 * marks unrooted objects; round 2 deletes those still unrooted once `graceMs`
 * has passed since round 1 completed. Any root change restarts at round 1, and
 * the cursor persists so a restarted DO resumes the page it was on.
 */
export async function sweepBinaryObjects(state: CoordinatorState, io: SweepIo, now: number, graceMs: number): Promise<BinaryGcResult> {
  state.rootGeneration ??= 0;
  const roots = gcRoots(state, now);
  state.binaryGcCandidates ??= {};
  if (!state.binaryGcSweep || state.binaryGcSweep.rootGeneration !== state.rootGeneration) {
    state.binaryGcSweep = { rootGeneration: state.rootGeneration, round: 1, attempts: 0 };
    state.binaryGcCandidates = {};
    await io.persist();
  }
  const sweep = state.binaryGcSweep;
  const completed = Object.values(state.binaryGcCandidates).find((candidate) => candidate.rootGeneration === state.rootGeneration)?.firstRoundCompletedAt;
  if (sweep.round === 2 && (completed === undefined || now - completed < graceMs)) {
    return { scanned: 0, deleted: 0, orphanBacklog: Object.keys(state.binaryGcCandidates).length, waitingForGrace: true, round: 2 };
  }
  const retrying = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) { sweep.attempts++; await io.persist(); await io.scheduleRetry(sweep.attempts); throw error; }
  };
  const prefix = `v2/${state.projectInstanceId}/`;
  const page = await retrying(() => io.bucket.list({ prefix, cursor: sweep.cursor, limit: 100 }));
  let deleted = 0;
  for (const object of page.objects) {
    if (!object.key.startsWith(prefix)) continue;
    if (roots.has(object.key)) { delete state.binaryGcCandidates[object.key]; continue; }
    if (sweep.round === 1) state.binaryGcCandidates[object.key] = { rootGeneration: state.rootGeneration };
    else if (state.binaryGcCandidates[object.key]?.rootGeneration === state.rootGeneration) {
      await retrying(() => io.bucket.delete(object.key));
      delete state.binaryGcCandidates[object.key]; deleted++;
    }
  }
  sweep.attempts = 0;
  sweep.cursor = page.truncated ? page.cursor : undefined;
  if (!page.truncated) {
    if (sweep.round === 1 && Object.keys(state.binaryGcCandidates).length) {
      for (const candidate of Object.values(state.binaryGcCandidates)) candidate.firstRoundCompletedAt = now;
      sweep.round = 2;
    } else {
      // Round 2 with zero candidates has nothing to delete: finish now.
      // Entering the round-2 grace wait without a stamped candidate would
      // park the sweep in `waitingForGrace` until the next root bump, so an
      // object orphaned without a generation change (e.g. an expired
      // uncommitted upload ticket) would never be collected.
      state.binaryGcSweep = { rootGeneration: state.rootGeneration, round: 1, attempts: 0 };
      state.binaryGcCandidates = {};
    }
  }
  await io.persist();
  const backlog = Object.keys(state.binaryGcCandidates).length;
  logEvent("binary_gc", { projectInstanceId: state.projectInstanceId, scanned: page.objects.length, deleted, orphanBacklog: backlog, round: sweep.round });
  return { scanned: page.objects.length, deleted, orphanBacklog: backlog, truncated: page.truncated, round: state.binaryGcSweep.round };
}
