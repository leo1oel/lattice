/**
 * Whether this page is a tab of a headless browser host (`--browser-host
 * --headless`, browser_host.rs), which keeps every project in this one tab.
 * browser-runtime.ts sets it from the host's session reply; it stays false in
 * a Lattice window and in a tab of any other host. A module of its own, so
 * what reads it needs nothing else of the runtime.
 */
let headless = false;

export const isHeadlessHost = (): boolean => headless;

export function markHeadlessHost(): void {
  headless = true;
}
