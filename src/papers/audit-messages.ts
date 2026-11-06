import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { bibTextToPlain } from "./bib-document";

/** A reference's title as LaTeX sets it ("{BERT}: Pre-training…" reads "BERT: Pre-training…"), else its key. */
export const auditEntryTitle = (entry: { title: string; key: string }) => bibTextToPlain(entry.title) || entry.key;

/** A local bibliography finding as `scan` reports it (`AuditIssue` in citation_audit.rs). */
export type CodedAuditIssue = {
  message: string;
  code?: string;
  params?: Record<string, string>;
};

/** A scan finding in the interface language; reports saved before codes existed keep their English. */
export function auditIssueText(issue: CodedAuditIssue): string {
  const params = issue.params ?? {};
  const type = params.type ?? "";
  switch (issue.code) {
    case "bibliography-conflict":
      return i18n._(msg`This bibliography has an unresolved Overleaf sync conflict. Resolve it before checking or updating its references.`);
    case "unparsed-constructs": {
      const count = params.count ?? "";
      return i18n._(msg`Could not parse ${count} bibliography construct(s).`);
    }
    case "unclosed-entry":
      return i18n._(msg`Unclosed bibliography entry; online check skipped.`);
    case "unknown-entry-type":
      return i18n._(msg`Unknown bibliography entry type \`${type}\`.`);
    case "empty-field": {
      const field = params.field ?? "";
      return i18n._(msg`Empty ${field} field.`);
    }
    case "repeated-authors":
      return i18n._(msg`Repeated author names; verify against the publication's author list before removing duplicates.`);
    case "missing-field": {
      // BibTeX field names, with at most one accepted alternative.
      const [field = "", alternative] = (params.requirement ?? "").split(" or ");
      return alternative
        ? i18n._(msg`Missing ${field} or ${alternative} field for ${type} entry.`)
        : i18n._(msg`Missing ${field} field for ${type} entry.`);
    }
    case "article-uses-booktitle":
      return i18n._(msg`Article entry uses booktitle instead of journal.`);
    case "proceedings-uses-journal":
      return type === "conference"
        ? i18n._(msg`Conference entry uses journal instead of booktitle.`)
        : i18n._(msg`Inproceedings entry uses journal instead of booktitle.`);
    case "invalid-year":
      return i18n._(msg`Invalid literal year; expected four digits.`);
    case "duplicate-key":
      return i18n._(msg`Duplicate citation key across bibliography files.`);
    case "duplicate-doi":
      return i18n._(msg`Duplicate DOI across bibliography files.`);
    case "duplicate-title":
      return i18n._(msg`Duplicate title across bibliography files.`);
    default:
      return issue.message;
  }
}

// `AuditResult.message` texts that reach the report without a
// `publicationReason` the panel already translates. Keyed by the exact
// English the Rust checks write (pinned by audit-messages.test.ts).
const RESULT_MESSAGES: Record<string, MessageDescriptor> = {
  "The bibliography entry changed after the scan.": msg`The bibliography entry changed after the scan.`,
  "The bibliography entry no longer exists.": msg`The bibliography entry no longer exists.`,
  "Kept as a preprint because pubstate is explicitly preprint.": msg`Kept as a preprint because pubstate is explicitly preprint.`,
  "No upgrade check was performed for this entry.": msg`No upgrade check was performed for this entry.`,
  "Preprint check returned an incomplete or ambiguous result.": msg`Preprint check returned an incomplete or ambiguous result.`,
  "bibcite returned invalid upgrade JSON.": msg`bibcite returned invalid upgrade JSON.`,
  "No published version was found.": msg`No published version was found.`,
  "The published version could not be confirmed.": msg`The published version could not be confirmed.`,
  "Verified publication metadata is available.": msg`Verified publication metadata is available.`,
  "Publication metadata was verified, but the citation-health check was incomplete.": msg`Publication metadata was verified, but the citation-health check was incomplete.`,
  "Metadata may be available, but the citation-health check was incomplete.": msg`Metadata may be available, but the citation-health check was incomplete.`,
  "Could not safely preserve this entry's BibTeX expressions.": msg`Could not safely preserve this entry's BibTeX expressions.`,
  "DOI metadata corrections are available.": msg`DOI metadata corrections are available.`,
  "Bibliography cleanup is available. Only the proposed changes will be applied; rejected source metadata is not used.": msg`Bibliography cleanup is available. Only the proposed changes will be applied; rejected source metadata is not used.`,
  "The inline reference agrees with the verified record.": msg`The inline reference agrees with the verified record.`,
  "A published version of this preprint exists. Inline references are edited by hand.": msg`A published version of this preprint exists. Inline references are edited by hand.`,
  "The verified record differs from this inline reference. Inline references are edited by hand.": msg`The verified record differs from this inline reference. Inline references are edited by hand.`,
};

/* eslint-disable lingui/no-unlocalized-strings -- prefixes matched in backend text (citation_audit/check.rs) */
export const METADATA_INCOMPLETE = "Metadata check incomplete: ";
export const PREPRINT_INCOMPLETE = "Preprint check incomplete: ";
/* eslint-enable lingui/no-unlocalized-strings */

/** An audit result's `message` in the interface language, when it is one Lattice wrote. */
export function auditResultMessage(message: string): string {
  const known = RESULT_MESSAGES[message];
  if (known) return i18n._(known);
  // The detail after the prefix is the lookup tool's own error text.
  if (message.startsWith(METADATA_INCOMPLETE)) {
    const error = message.slice(METADATA_INCOMPLETE.length);
    return i18n._(msg`Metadata check incomplete: ${error}`);
  }
  if (message.startsWith(PREPRINT_INCOMPLETE)) {
    const error = message.slice(PREPRINT_INCOMPLETE.length);
    return i18n._(msg`Preprint check incomplete: ${error}`);
  }
  return message;
}

/** Source names Rust reports as display text rather than as an id. */
export function auditSourceName(source: string): string {
  switch (source) {
    case "Crossref / official proceedings":
      return i18n._(msg`Crossref / official proceedings`);
    case "ICLR Proceedings":
      return i18n._(msg`ICLR Proceedings`);
    case "NeurIPS Proceedings":
      return i18n._(msg`NeurIPS Proceedings`);
    default:
      return source;
  }
}

/** What a source answered about a reference, as the report says it. */
const SOURCE_OUTCOMES: Record<string, MessageDescriptor> = {
  matched: msg`Verified publication match`,
  selected: msg`Metadata source`,
  selected_cached: msg`Metadata source (cached)`,
  candidate: msg`Candidate record considered, not verified`,
  candidate_cached: msg`Candidate record considered, not verified (cached record)`,
  not_configured: msg`Not enabled. Add your own API key in Settings`,
  no_match: msg`No published version found`, rate_limited: msg`Rate limited`,
  batch_reused: msg`Batch result reused`, queue_busy: msg`Request queue busy`,
  daily_quota: msg`Public daily quota exhausted`,
  batch_rate_limited: msg`Rate limited; subsequent Semantic Scholar queries skipped`,
  batch_queue_busy: msg`Request queue busy; subsequent Semantic Scholar queries skipped`,
  batch_daily_quota: msg`Public daily quota exhausted; subsequent Semantic Scholar queries skipped`,
  batch_upstream_rate_limit: msg`Semantic Scholar rate limited the service; subsequent queries skipped`,
  batch_unauthorized: msg`Semantic Scholar authorization failed; subsequent queries skipped`,
  batch_network: msg`Semantic Scholar connection failed; subsequent queries skipped`,
  batch_malformed: msg`Semantic Scholar returned an invalid response; subsequent queries skipped`,
  batch_timeout: msg`Semantic Scholar request timed out; subsequent queries skipped`,
  batch_unavailable: msg`Semantic Scholar unavailable; subsequent queries skipped`,
  blocked: msg`Requests blocked`, timeout: msg`Request timed out`,
  connection_failed: msg`Connection failed`, network: msg`Network connection failed`,
  unauthorized: msg`Authorization failed`, malformed: msg`Invalid response from source`,
  forbidden: msg`Access forbidden by provider`,
  upstream_rate_limit: msg`Source rate limit reached`, server_error: msg`Source service error`,
  unavailable: msg`Source temporarily unavailable`,
};

/** A source's answer in the interface language; `status` is the whole result's. */
export function auditSourceOutcome(status: string, outcome: string): string {
  // Reports saved before candidate outcomes existed may say that a source was
  // selected even though the final result was unavailable. Do not present
  // those records as verified or accepted.
  if (status === "unavailable" && outcome === "selected") return i18n._(msg`Source record considered, not verified`);
  if (status === "unavailable" && outcome === "selected_cached") return i18n._(msg`Source record considered, not verified (cached record)`);
  const message = SOURCE_OUTCOMES[outcome];
  return message ? i18n._(message) : i18n._(msg`Unknown source response`);
}
