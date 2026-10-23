import { msg } from "@lingui/core/macro";
import { parseKeyName } from "../app/key-combos";

/**
 * The keys of Check references' review queue, in one table: the sheet's own
 * handler reads them, its Apply and Skip buttons show theirs, and the shortcut
 * sheet lists them all (shortcut-groups.ts), so a moved key moves everywhere.
 */
export const REFERENCE_CHECK_SHORTCUTS = {
  next: { key: "j", label: msg`Next reference` },
  previous: { key: "k", label: msg`Previous reference` },
  apply: { key: "a", label: msg`Apply the fix` },
  applyChord: { key: "Mod-Enter", label: msg`Apply the fix` },
  skip: { key: "s", label: msg`Skip to the next finding` },
} as const;

export type ReferenceCheckAction = keyof typeof REFERENCE_CHECK_SHORTCUTS;

/** The queue action `event` asks for: its key exactly, with no other modifier held. */
export function referenceCheckAction(event: KeyboardEvent): ReferenceCheckAction | null {
  for (const [action, { key }] of Object.entries(REFERENCE_CHECK_SHORTCUTS) as [ReferenceCheckAction, { key: string }][]) {
    const combo = parseKeyName(key);
    if (event.key.toLowerCase() !== combo.key.toLowerCase()) continue;
    if (!!combo.mod !== (event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) continue;
    return action;
  }
  return null;
}
