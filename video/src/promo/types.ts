import type { TransitionPresentation } from "@remotion/transitions";
import type { RevealStyle } from "./TextReveal";
import type { MotionVariant } from "./SceneMotion";

export interface Caption {
  /**
   * ABSOLUTE source seconds — the timestamp in the recording this caption
   * belongs to, so it can be read straight off the capture. FeatureScene
   * converts it to a composition offset, dividing by the segment's rate.
   */
  at: number;
  /** How long it stays up, in COMPOSITION seconds (i.e. real screen time). */
  hold: number;
  label: string;
  headline: string;
}

export interface Beat {
  /** Source timestamps in seconds, measured off the recording. */
  from: number;
  to: number;
  /**
   * Playback speed. The captures are real-time screen recordings and a lot of
   * the motion is slower than a promo can afford, so most runs play at 1.6-2.4x.
   * Scene length becomes (to - from) / rate.
   */
  rate: number;
  /** `object-position` for this run — see ScreenCard. */
  focus?: string;
  captions: Caption[];
}

export interface Scene {
  key: string;
  duration: number;
  node: React.ReactNode;
  /** Screen-level motion for this scene; neighbours never share one. */
  motion: MotionVariant;
  /** Frames to arrive and leave. Varied on purpose — a film where every scene
   *  eases identically reads as mechanical. */
  enter: number;
  exit: number;
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

/** Line reveals, cycled so no two consecutive captions arrive identically. */
export const REVEALS: RevealStyle[] = ["rise", "fade", "scale"];

/**
 * Absolute start frame of every scene, keyed by `scene.key`.
 *
 * TransitionSeries overlaps neighbours, so a scene starts where the previous
 * one started plus its duration minus the transition between them. The
 * soundtrack anchors its cues to these keys rather than to hardcoded frames, so
 * retiming a segment moves its sound effects with it.
 */
export const sceneStarts = (section: Section): Record<string, number> => {
  const starts: Record<string, number> = {};
  let cursor = 0;
  section.scenes.forEach((scene, i) => {
    starts[scene.key] = cursor;
    cursor += scene.duration - (section.transitions[i]?.frames ?? 0);
  });
  return starts;
};

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
