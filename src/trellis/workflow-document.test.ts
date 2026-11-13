import { beforeEach, expect, it } from "vitest";
import { rememberWorkflowDocument, workflowDocument } from "./workflow-document";

beforeEach(() => localStorage.clear());
it("remembers a separate document for each project and workflow", () => {
  rememberWorkflowDocument("one", "writing", "main.tex");
  rememberWorkflowDocument("one", "reading", "paper.pdf");
  rememberWorkflowDocument("two", "writing", "other.tex");
  const tabs = ["main.tex", "paper.pdf", "other.tex"];
  expect(workflowDocument("one", "writing", tabs)).toBe("main.tex");
  expect(workflowDocument("one", "reading", tabs)).toBe("paper.pdf");
  expect(workflowDocument("two", "writing", tabs)).toBe("other.tex");
});
it("does not reopen a document that the user closed", () => {
  rememberWorkflowDocument("one", "writing", "main.tex");
  expect(workflowDocument("one", "writing", ["notes.md"])).toBeNull();
});
it("recovers from invalid settings and remembers custom layouts separately", () => {
  localStorage.setItem("lattice.workflow-documents.v1:one", "invalid");
  expect(workflowDocument("one", "writing", ["main.tex"])).toBeNull();
  rememberWorkflowDocument("one", null, "notes.md");
  expect(workflowDocument("one", null, ["notes.md"])).toBe("notes.md");
  expect(workflowDocument("one", "writing", ["notes.md"])).toBeNull();
});
