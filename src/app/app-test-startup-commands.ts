/* eslint-disable lingui/no-unlocalized-strings -- test-only code: an error message for the test log, not interface copy */
/** Answers the commands every window issues at startup; rejects any other command a test did not declare. */
export function mockAppCommand(command: string) {
  if (command === "list_citations") return { citations: [], skipped: [] };
  if (command === "list_references") return { references: [], skipped: [] };
  if (command === "list_local_templates") return [];
  // Every project entry reads its annotations; an unanswered read would refuse annotation saves.
  if (command === "list_annotations") return { annotations: [], rounds: [] };
  // An English document, which Harper checks.
  if (command === "spelling_document_language") return null;
  throw new Error(`Unexpected command: ${command}`);
}
