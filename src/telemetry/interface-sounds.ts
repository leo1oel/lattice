import {
  play,
  setEnabled,
  setVolume,
  type SoundName,
} from "cuelume";

/**
 * Semantic cues are deliberately narrower than Cuelume's full interaction
 * palette. Routine clicks, navigation, editing, and automatic builds stay
 * silent; callers opt in only when a user-requested operation has finished.
 */
const SOUND_BY_CUE = {
  "build-succeeded": "ready",
  "build-failed": "error",
  "collaboration-ready": "arrival",
} as const satisfies Record<string, SoundName>;

export type InterfaceSoundCue = keyof typeof SOUND_BY_CUE;

export function configureInterfaceSounds(enabled: boolean): void {
  setVolume(0.5);
  setEnabled(enabled);
}

export function playInterfaceSound(cue: InterfaceSoundCue): void {
  try {
    play(SOUND_BY_CUE[cue]);
  } catch {
    // Optional feedback must never turn a completed operation into a failure.
  }
}
