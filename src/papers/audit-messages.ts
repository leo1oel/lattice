import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

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
};

/* eslint-disable lingui/no-unlocalized-strings -- prefixes matched in backend text */
const METADATA_INCOMPLETE = "Metadata check incomplete: ";
const PREPRINT_INCOMPLETE = "Preprint check incomplete: ";
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
