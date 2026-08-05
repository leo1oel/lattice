import { findFencedRegions, isInsideFence } from './fence-regions.ts';

const REF_DEF_RE = /^[ \t]{0,3}\[([^\]]+)\]:\s*(\S+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm;

export function hoistRefDefs(src: string): string {
  const fences = findFencedRegions(src);
  const defs: string[] = [];

  for (const match of src.matchAll(REF_DEF_RE)) {
    if (!isInsideFence(match.index, fences)) {
      defs.push(match[0].trimEnd());
    }
  }

  return defs.length > 0 ? `${defs.join('\n')}\n\n` : '';
}
