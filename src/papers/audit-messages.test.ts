import { describe, expect, it } from "vitest";
import { auditIssueText, auditResultMessage, auditSourceName } from "./audit-messages";

describe("audit messages", () => {
  it("render scan findings with the English the host writes", () => {
    const cases: [string, Record<string, string>, string][] = [
      ["missing-field", { requirement: "year or date", type: "article" }, "Missing year or date field for article entry."],
      ["missing-field", { requirement: "journal", type: "article" }, "Missing journal field for article entry."],
      ["proceedings-uses-journal", { type: "inproceedings" }, "Inproceedings entry uses journal instead of booktitle."],
      ["unknown-entry-type", { type: "madeup" }, "Unknown bibliography entry type `madeup`."],
      ["duplicate-doi", {}, "Duplicate DOI across bibliography files."],
      ["unparsed-constructs", { count: "2" }, "Could not parse 2 bibliography construct(s)."],
    ];
    for (const [code, params, english] of cases) {
      expect(auditIssueText({ message: "raw", code, params })).toBe(english);
    }
    expect(auditIssueText({ message: "Missing author field." })).toBe("Missing author field.");
  });

  it("recognizes only result messages the checks still write", () => {
    for (const message of [
      "Kept as a preprint because pubstate is explicitly preprint.",
      "DOI metadata corrections are available.",
      "Bibliography cleanup is available. Only the proposed changes will be applied; rejected source metadata is not used.",
      "Metadata may be available, but the citation-health check was incomplete.",
    ]) {
      expect(auditResultMessage(message)).toBe(message);
    }
    expect(auditResultMessage("Metadata check incomplete: timeout")).toBe("Metadata check incomplete: timeout");
    expect(auditResultMessage("Something new.")).toBe("Something new.");
    expect(auditSourceName("ICLR Proceedings")).toBe("ICLR Proceedings");
    expect(auditSourceName("dblp")).toBe("dblp");
  });
});
