/* eslint-disable lingui/no-unlocalized-strings -- test-only code: an error message for the test log, not interface copy */
/** Answers the commands every window issues at startup; rejects any other command a test did not declare. */
export function mockAppCommand(command: string) {
  if (command === "list_citations") return { citations: [], skipped: [] };
  if (command === "list_references") return { references: [], skipped: [] };
  if (command === "list_local_templates") return [];
  throw new Error(`Unexpected command: ${command}`);
}
