export const ORPHAN_MODES = ['incoming', 'outgoing', 'both'] as const;

export type OrphanMode = (typeof ORPHAN_MODES)[number];

export function isOrphanMode(value: string): value is OrphanMode {
  return ORPHAN_MODES.includes(value as OrphanMode);
}
