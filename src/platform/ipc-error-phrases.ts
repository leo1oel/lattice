/**
 * Backend errors cross IPC as English prose, so the UI recognizes some of
 * them by a phrase in the text. Each phrase is an exported const beside the
 * code that matches it, and `ipc-error-phrases.test.ts` pins every one to the
 * Rust source that writes it: rewording a Rust message would otherwise change
 * retry and sign-out behaviour with every test green.
 */

/** Whether `message` contains any of `phrases`, ignoring case. */
export function mentionsAny(message: string, phrases: readonly string[]): boolean {
  const lower = message.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase.toLowerCase()));
}
