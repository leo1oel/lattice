import { describe, expect, it } from "vitest";
import { testTimeoutSeconds, watchTestOutput } from "./test-timeout.mjs";

function fakeTimers() {
  const timers = new Map();
  let next = 0;
  return {
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimer: (id) => timers.delete(id),
    timers,
  };
}

describe("watchTestOutput", () => {
  it("times out a test that warned and never ended, counting from its start", () => {
    const clock = fakeTimers();
    const fired = [];
    const watch = watchTestOutput({ limitSeconds: 300, onTimeout: (name) => fired.push(name), ...clock });
    watch.line("running 3 tests");
    watch.line("test app_log::tests::trims ... ok");
    watch.line("test app_log::tests::loops has been running for over 60 seconds");
    expect([...clock.timers.values()].map((timer) => timer.ms)).toEqual([240_000]);
    [...clock.timers.values()][0].fn();
    expect(fired).toEqual(["app_log::tests::loops"]);
  });

  it("clears the timer when the slow test ends, whatever its verdict", () => {
    const clock = fakeTimers();
    const watch = watchTestOutput({ limitSeconds: 300, onTimeout: () => expect.unreachable(), ...clock });
    watch.line("test slow::one has been running for over 60 seconds");
    watch.line("test slow::two has been running for over 60 seconds");
    watch.line("test slow::one ... ok");
    watch.line("test slow::two ... FAILED");
    expect(clock.timers.size).toBe(0);
  });

  it("reads its limit from the environment", () => {
    expect(testTimeoutSeconds({})).toBe(300);
    expect(testTimeoutSeconds({ LATTICE_GPUI_TEST_TIMEOUT_SECONDS: "90" })).toBe(90);
    expect(testTimeoutSeconds({ LATTICE_GPUI_TEST_TIMEOUT_SECONDS: "x" })).toBe(300);
  });
});
