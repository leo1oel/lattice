/**
 * A PDF viewer brought on screen by a workspace or layout switch mounts once
 * the switch has finished animating (TrellisController.beginSwitch): its first
 * layout and page drawing, in the switch's frames, stalled the titlebar
 * switch's plate mid-way (Beta r20). Once mounted it stays; give it a `key`
 * per document so another document waits again.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";

/** Whether a switch is animating, and when that changes. */
export type SwitchState = {
  subscribe: (listener: () => void) => () => void;
  switching: () => boolean;
};

export function AfterSwitch({ state, children }: { state: SwitchState; children: ReactNode }) {
  const switching = useSyncExternalStore(state.subscribe, state.switching);
  const [settled, setSettled] = useState(!switching);
  if (!switching && !settled) setSettled(true);
  return settled ? children : null;
}
