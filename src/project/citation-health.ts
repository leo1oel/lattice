import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../i18n";
import type { PaperSummary } from "../app-types";

type CitationHealth = NonNullable<PaperSummary["citationHealth"]>;

/** Descriptors, not strings: resolving at call time picks up the active catalog. */
const KIND_LABELS: Partial<Record<CitationHealth["kind"], MessageDescriptor>> = {
  retracted: msg`Retracted`,
  expressionOfConcern: msg`Expression of concern`,
  corrected: msg`Correction/update`,
  replaced: msg`Replacement/new version`,
};

const SOURCE_LABELS = new Map<string, MessageDescriptor>([
  ["retraction-watch", msg`Retraction Watch`],
  ["publisher", msg`Publisher`],
]);

/**
 * The row's visible warning in two parts — what happened, then who reported
 * it and when — or null when Crossref reports nothing to warn about.
 */
export function citationHealthParts(health: CitationHealth | undefined): { kind: string; detail: string } | null {
  const kind = health && KIND_LABELS[health.kind];
  if (!health || !kind) return null;
  const source = health.source && SOURCE_LABELS.get(health.source);
  return {
    kind: i18n._(kind),
    detail: [
      source ? i18n._(source) : health.source,
      health.date,
      health.stale ? i18n._(msg`cached`) : null,
    ].filter(Boolean).join(" · "),
  };
}

/** The row's visible warning as one line, or null when there is none. */
export function citationHealthLabel(health: CitationHealth | undefined): string | null {
  const parts = citationHealthParts(health);
  return parts && [parts.kind, parts.detail].filter(Boolean).join(" · ");
}

/** The full explanation, including the "nothing found" and "unavailable" outcomes. */
export function citationHealthTitle(health: CitationHealth | undefined): string | undefined {
  if (!health) return undefined;
  const updateType = health.updateType?.replaceAll("_", " ");
  const warning = citationHealthLabel(health);
  if (warning) {
    return updateType ? i18n._(msg`${warning}. Crossref type: ${updateType}`) : warning;
  }
  if (health.kind === "unavailable") return i18n._(msg`Crossref citation-health metadata is currently unavailable`);
  if (updateType) return i18n._(msg`Crossref reports update type: ${updateType}`);
  const checkedDate = health.checkedAt.slice(0, 10);
  return i18n._(msg`No Crossref update metadata found (checked ${checkedDate})`);
}
