import { isBrowserHosted } from "../platform/browser-runtime";

export function isMobileWorkspace(): boolean {
  return isBrowserHosted() && window.matchMedia("(max-width: 700px)").matches;
}
