import type { TransitionPresentation } from "@remotion/transitions";

export interface Caption {
  /** Seconds from the start of the beat. */
  at: number;
  hold: number;
  label: string;
  headline: string;
}

export interface Beat {
  /** Source timestamps in seconds, measured off the recording. */
  from: number;
  to: number;
  captions: Caption[];
}

export interface Scene {
  key: string;
  duration: number;
  node: React.ReactNode;
}

export interface TransitionSpec {
  frames: number;
  presentation: TransitionPresentation<never>;
}

/** A run of scenes with the transitions between them — one per gap, so
 *  `transitions.length` is always `scenes.length - 1`. */
export interface Section {
  scenes: Scene[];
  transitions: TransitionSpec[];
}

/** TransitionSeries overlaps neighbours, so every transition shortens the total. */
export const sectionDuration = (section: Section) =>
  section.scenes.reduce((total, scene) => total + scene.duration, 0) -
  section.transitions.reduce((total, transition) => total + transition.frames, 0);

/** Concatenate two sections with a transition bridging them. */
export const joinSections = (
  a: Section,
  bridge: TransitionSpec,
  b: Section,
): Section => ({
  scenes: [...a.scenes, ...b.scenes],
  transitions: [...a.transitions, bridge, ...b.transitions],
});
