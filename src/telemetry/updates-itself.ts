/**
 * False on Linux, where Lattice ships as an AppImage that updates by hand: its
 * release has no updater archive, latest.json has no Linux entry, and the
 * backend does not register the updater plugin there (lib.rs). False on the
 * experimental Windows host too. An Android browser opening the web demo is
 * not the Linux desktop (`hostPlatform`).
 */
import { hostPlatform } from "../platform/host-platform";

export function updatesItself(): boolean {
  return hostPlatform() === "mac";
}
