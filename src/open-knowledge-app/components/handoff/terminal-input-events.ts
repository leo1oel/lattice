/**
 * Local seam — not upstream code.
 *
 * Upstream routes "send to terminal" requests to a live CLI session via this
 * event; the host has no terminal handoff, so the dispatch is a no-op signal
 * with upstream's signature.
 */
const ACTIVE_TERMINAL_INPUT_EVENT = "open-knowledge:active-terminal-input";

export interface ActiveTerminalInputDetail {
  readonly text: string;
  readonly newTab: boolean;
  readonly submit: boolean;
}

export function requestActiveTerminalInput(
  text: string,
  options?: { newTab?: boolean; submit?: boolean },
  target: Pick<Window, "dispatchEvent"> | EventTarget = typeof window === "undefined"
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(
    new CustomEvent<ActiveTerminalInputDetail>(ACTIVE_TERMINAL_INPUT_EVENT, {
      detail: { text, newTab: options?.newTab === true, submit: options?.submit === true },
    }),
  );
}
