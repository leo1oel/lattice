/**
 * A change the revision rounds made to the page's view of the annotations,
 * as the window's store takes it (`change_annotations`,
 * `agent/surface/annotations.rs`): what was added or changed and what was
 * removed, the annotations by id and the rounds by number. The store applies
 * it to what it holds, so what another writer added meanwhile (a note in the
 * Annotations panel) is kept; a whole copy saved instead would drop it.
 */
import type { AnnotationsState } from "../../../src/app/use-editor-comments";

type Annotation = AnnotationsState["annotations"][number];
type Round = AnnotationsState["rounds"][number];

export interface AnnotationsChange {
  upsert: Annotation[];
  remove: string[];
  roundsUpsert: Round[];
  roundsRemove: number[];
}

/** What of `items` changed from `current` to `next`, by `key`. */
function diff<T, K>(current: readonly T[], next: readonly T[], key: (item: T) => K): { upsert: T[]; remove: K[] } {
  const before = new Map(current.map((item) => [key(item), item]));
  const kept = new Set(next.map(key));
  const upsert = next.filter((item) => {
    const old = before.get(key(item));
    return old === undefined || (old !== item && JSON.stringify(old) !== JSON.stringify(item));
  });
  const remove = current.map(key).filter((id) => !kept.has(id));
  return { upsert, remove };
}

export function annotationsChange(current: AnnotationsState, next: AnnotationsState): AnnotationsChange | null {
  const annotations = diff(current.annotations, next.annotations, (item) => item.id);
  const rounds = diff(current.rounds, next.rounds, (round) => round.number);
  if (!annotations.upsert.length && !annotations.remove.length && !rounds.upsert.length && !rounds.remove.length) return null;
  return { upsert: annotations.upsert, remove: annotations.remove, roundsUpsert: rounds.upsert, roundsRemove: rounds.remove };
}
