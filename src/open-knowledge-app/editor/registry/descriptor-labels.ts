/**
 * Local seam — not upstream code.
 *
 * Upstream descriptors (src/open-knowledge-core/registry/built-ins.ts) carry
 * English `displayName` / `placeholder.label` / `emptyChildName` strings, and
 * PropPanel derives field labels from prop identifiers. Those identifiers are
 * written into the user's Markdown, so they stay untouched; this module maps
 * them to catalog messages at the render sites instead.
 *
 * Display names and placeholder labels are keyed by their English text rather
 * than the descriptor name: if upstream rewords one, the lookup misses and the
 * new English shows, instead of a translation of the old wording.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from '../../../i18n';
import { humanizePropName } from '../utils/editor-strings.ts';
import type { JsxComponentDescriptor } from './types.ts';

const DISPLAY_NAMES: Record<string, MessageDescriptor> = {
  Callout: msg`Callout`,
  Image: msg`Image`,
  Video: msg`Video`,
  Audio: msg`Audio`,
  PDF: msg`PDF`,
  File: msg`File`,
  Embed: msg`Embed`,
  Accordion: msg`Accordion`,
  Toggle: msg`Toggle`,
  Tabs: msg`Tabs`,
  Tab: msg`Tab`,
  'Paper figure': msg`Paper figure`,
  'Paper figure row': msg`Paper figure row`,
  'Paper figure panel': msg`Paper figure panel`,
  Math: msg`Math`,
  Mermaid: msg`Mermaid`,
  Mirror: msg`Mirror`,
  'Mirror Source': msg`Mirror Source`,
  'GFM Callout': msg`GFM Callout`,
  'CommonMark Image': msg`CommonMark Image`,
  'Wiki Embed Image': msg`Wiki Embed Image`,
  'Wiki Embed Video': msg`Wiki Embed Video`,
  'Wiki Embed Audio': msg`Wiki Embed Audio`,
  'Wiki Embed File': msg`Wiki Embed File`,
  'HTML5 Details': msg`HTML5 Details`,
  'Align block': msg`Align block`,
  'Dollar Math': msg`Dollar Math`,
  'Math Fence': msg`Math Fence`,
};

const PLACEHOLDER_LABELS: Record<string, MessageDescriptor> = {
  'Add an image': msg`Add an image`,
  'Add a video': msg`Add a video`,
  'Add audio': msg`Add audio`,
  'Add a PDF': msg`Add a PDF`,
  'Add a file': msg`Add a file`,
  'Embed a URL': msg`Embed a URL`,
  'Add a Mermaid diagram': msg`Add a Mermaid diagram`,
};

/** Keyed by prop identifier; the English matches `humanizePropName`'s output. */
const PROP_LABELS: Record<string, MessageDescriptor> = {
  align: msg({ message: 'Align', context: 'layout property' }),
  alias: msg`Alias`,
  alt: msg`Alt`,
  anchor: msg`Anchor`,
  autoplay: msg`Autoplay`,
  collapsible: msg`Collapsible`,
  color: msg`Color`,
  controls: msg`Controls`,
  crossorigin: msg`Crossorigin`,
  decoding: msg`Decoding`,
  defaultOpen: msg`Default Open`,
  description: msg`Description`,
  fetchpriority: msg`Fetchpriority`,
  formula: msg`Formula`,
  height: msg`Height`,
  icon: msg`Icon`,
  id: msg`Id`,
  label: msg`Label`,
  language: msg`Language`,
  loading: msg`Loading`,
  loop: msg`Loop`,
  muted: msg`Muted`,
  name: msg`Name`,
  playsinline: msg`Playsinline`,
  poster: msg`Poster`,
  preload: msg`Preload`,
  referrerpolicy: msg`Referrerpolicy`,
  sizes: msg`Sizes`,
  src: msg`Src`,
  srcset: msg`Srcset`,
  title: msg`Title`,
  type: msg`Type`,
  width: msg`Width`,
};

function lookup(table: Record<string, MessageDescriptor>, key: string): string | undefined {
  const message = Object.hasOwn(table, key) ? table[key] : undefined;
  return message ? i18n._(message) : undefined;
}

/** Localized component name for chrome, aria labels and placeholders. */
export function descriptorDisplayName(descriptor: Pick<JsxComponentDescriptor, 'name' | 'displayName'>): string {
  const english = descriptor.displayName ?? descriptor.name;
  return lookup(DISPLAY_NAMES, english) ?? english;
}

/** Localized child-component name (a descriptor's `emptyChildName`, e.g. `Tab`). */
export function childComponentLabel(name: string): string {
  return lookup(DISPLAY_NAMES, name) ?? name;
}

/** Localized empty-state label, or `undefined` when the descriptor declares none. */
export function descriptorPlaceholderLabel(descriptor: Pick<JsxComponentDescriptor, 'placeholder'>): string | undefined {
  const english = descriptor.placeholder?.label;
  if (english === undefined) return undefined;
  return lookup(PLACEHOLDER_LABELS, english) ?? english;
}

/** Localized PropPanel field label for a prop identifier. */
export function propDisplayName(name: string): string {
  return lookup(PROP_LABELS, name) ?? humanizePropName(name);
}
