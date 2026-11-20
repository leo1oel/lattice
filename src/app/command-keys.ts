/**
 * The keys of commands that a sentence names too (the Get started steps, the
 * Build card, the status bar's Go to line, the Plugins intro): the command
 * table binds these and the sentence is written from them, so the two cannot
 * drift apart and each keyboard reads its own modifier names (key-combos.ts).
 * Dependency-free, as pdf-keys.ts is, so anything can read them without
 * loading the table.
 */
export const PALETTE_KEY = { key: "k" } as const;
export const SAVE_KEY = { key: "s" } as const;
export const CITE_KEY = { key: "k", shift: true } as const;
export const GOTO_LINE_KEY = { key: "g" } as const;
