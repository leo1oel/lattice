import { protectFromMdx } from './autolink-void-html-guard.ts';
import { encodeBackslashEscapes } from './backslash-escape-guard.ts';
import { encodeEntityRefs } from './entity-ref-guard.ts';

export function protectParserSource(source: string): string {
  return encodeEntityRefs(protectFromMdx(encodeBackslashEscapes(source)));
}
