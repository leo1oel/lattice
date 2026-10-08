import { useSyncExternalStore } from "react";
import type { ToastPosition } from "../settings/app-settings";

/*
 * Where the notification stack stands. App applies the stored Settings →
 * Appearance choice here; the stack, mounted outside App (main.tsx), reads it.
 */
let position: ToastPosition = "top-right";
const listeners = new Set<() => void>();

export function configureToastPosition(next: ToastPosition) {
  if (next === position) return;
  position = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToastPosition(): ToastPosition {
  return useSyncExternalStore(subscribe, () => position, () => position);
}
