import { chunk } from "../lib/lazy-chunk";

/**
 * The Terminal panel's chunk: xterm.js, the panel and the shells' plumbing.
 * One loader, so every caller shares one copy of it (canvas-lazy-modules.ts).
 */
export const loadTerminalPanel = chunk(() => import("./terminal-chunk"));

export type TerminalChunk = Awaited<ReturnType<typeof loadTerminalPanel>>;

/** Run `action` once the chunk is in. */
export const withTerminals = (action: (module: TerminalChunk) => void) => () => {
  void loadTerminalPanel().then(action);
};
