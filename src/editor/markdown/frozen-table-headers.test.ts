import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyScrollDrivenFreeze } from '@ok-app/editor/extensions/frozen-table-headers';

type RecordedAnimation = Animation & { assignedStartTime?: CSSNumberish };

const originalCSS = globalThis.CSS;
const stubCSS = (value: unknown) => Object.defineProperty(globalThis, 'CSS', { configurable: true, value });
const timelineStart = { value: 0, unit: 'percent' } as unknown as CSSNumberish;

afterEach(() => {
  vi.restoreAllMocks();
  stubCSS(originalCSS);
});

function apply(occludeTop: boolean, rejectStartTime = false): RecordedAnimation[] {
  const animations = Array.from({ length: occludeTop ? 3 : 2 }, () => {
    const animation = { cancel: vi.fn() } as unknown as RecordedAnimation;
    Object.defineProperty(animation, 'startTime', {
      configurable: true,
      get: () => animation.assignedStartTime ?? null,
      set: (value: CSSNumberish | null) => {
        if (rejectStartTime) throw new TypeError('Percentage start times are unsupported');
        if (value != null) animation.assignedStartTime = value;
      },
    });
    return animation;
  });
  const cell = document.createElement('th');
  cell.animate = vi.fn(() => animations.shift() as Animation);
  applyScrollDrivenFreeze(cell, {} as AnimationTimeline, { startOffset: 100, endOffset: 300, maxShift: 200 }, 1000, occludeTop);
  return (cell.animate as ReturnType<typeof vi.fn>).mock.results.map(({ value }) => value as RecordedAnimation);
}

describe('frozen table header animation continuity', () => {
  it.each([
    ['transform, chrome, and optional occluder animations', true, 3],
    ['only the required animations when no occluder is needed', false, 2],
  ])('pins %s to timeline zero', (_name, occludeTop, count) => {
    const percent = vi.fn(() => timelineStart);
    stubCSS({ percent });

    const animations = apply(occludeTop);

    expect(percent).toHaveBeenCalledExactlyOnceWith(0);
    expect(animations.map((animation) => animation.assignedStartTime)).toEqual(Array(count).fill(timelineStart));
  });

  it('keeps the WebKit fallback when CSS.percent is absent or rejects the value', () => {
    stubCSS({});
    expect(() => apply(true)).not.toThrow();
    stubCSS({ percent: () => { throw new TypeError('CSS percentages are unsupported'); } });
    expect(() => apply(true)).not.toThrow();
  });

  it('retains the animations when the engine accepts CSS.percent but rejects startTime', () => {
    stubCSS({ percent: () => timelineStart });
    const animations = apply(true, true);
    expect(animations.map((animation) => animation.startTime)).toEqual([null, null, null]);
    for (const animation of animations) expect(animation.cancel).not.toHaveBeenCalled();
  });
});
