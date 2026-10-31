/* eslint-disable lingui/no-unlocalized-strings -- test-only code: an error message for the test log, not interface copy */
/** Answers the commands every window issues at startup; rejects any other command a test did not declare. */
export function mockAppCommand(command: string) {
  if (["list_citations", "list_references", "list_local_templates"].includes(command)) return [];
  throw new Error(`Unexpected command: ${command}`);
}
