import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyScrollDrivenFreeze } from '@ok-app/editor/extensions/frozen-table-headers';

const originalCSS = globalThis.CSS;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: originalCSS });
});

function apply(occludeTop: boolean, rejectStartTime = false): Array<Animation & { assignedStartTime?: CSSNumberish }> {
  const animations = Array.from({ length: occludeTop ? 3 : 2 }, () => {
    const animation = { cancel: vi.fn() } as unknown as Animation & {
      assignedStartTime?: CSSNumberish;
    };
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

  applyScrollDrivenFreeze(
    cell,
    {} as AnimationTimeline,
    { startOffset: 100, endOffset: 300, maxShift: 200 },
    1000,
    occludeTop,
  );

  return (cell.animate as ReturnType<typeof vi.fn>).mock.results.map(
    ({ value }) => value as Animation & { assignedStartTime?: CSSNumberish },
  );
}

describe('frozen table header animation continuity', () => {
  it('pins transform, chrome, and optional occluder animations to timeline zero', () => {
    const timelineStart = { value: 0, unit: 'percent' } as unknown as CSSNumberish;
    const percent = vi.fn(() => timelineStart);
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { percent },
    });

    const animations = apply(true);

    expect(percent).toHaveBeenCalledOnce();
    expect(percent).toHaveBeenCalledWith(0);
    expect(animations).toHaveLength(3);
    expect(animations.map((animation) => animation.assignedStartTime)).toEqual([
      timelineStart,
      timelineStart,
      timelineStart,
    ]);
  });

  it('pins only the required animations when no occluder is needed', () => {
    const timelineStart = { value: 0, unit: 'percent' } as unknown as CSSNumberish;
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { percent: () => timelineStart },
    });

    const animations = apply(false);

    expect(animations).toHaveLength(2);
    expect(animations.every((animation) => animation.assignedStartTime === timelineStart)).toBe(true);
  });

  it('keeps the WebKit fallback when CSS.percent is absent or rejects the value', () => {
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });
    expect(() => apply(true)).not.toThrow();

    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: {
        percent: () => {
          throw new TypeError('CSS percentages are unsupported');
        },
      },
    });
    expect(() => apply(true)).not.toThrow();
  });

  it('retains the animations when the engine accepts CSS.percent but rejects startTime', () => {
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { percent: () => ({ value: 0, unit: 'percent' }) },
    });
    const animations = apply(true, true);
    expect(animations).toHaveLength(3);
    expect(animations.map((animation) => animation.startTime)).toEqual([null, null, null]);
    for (const animation of animations) expect(animation.cancel).not.toHaveBeenCalled();
  });
});
