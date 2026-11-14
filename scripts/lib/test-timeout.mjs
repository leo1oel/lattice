/**
 * A per-test timeout for `cargo test` run through `scripts/gpui-build.mjs`,
 * which holds the machine-wide build lock for as long as the tests run: a
 * review-fix agent's new unit test that looped forever held it for over 15
 * minutes, and every other lane's compile queued behind it.
 *
 * Stable libtest has no timeout of its own (`--ensure-time` is nightly, and
 * cargo-nextest is not installed on the machine), but it does print
 * `test <name> has been running for over 60 seconds` once a test passes 60 s,
 * and `test <name> ... ok` (or FAILED, ignored) when one ends. So this reads
 * the test binaries' stdout line by line: a test that warned and has not
 * ended within the limit, counted from its start, is reported to `onTimeout`,
 * which stops the run and fails it naming the test. The limit is therefore
 * at least 60 s; it is 300 s unless `LATTICE_GPUI_TEST_TIMEOUT_SECONDS` says
 * otherwise.
 */

const RUNNING = /^test (.+) has been running for over (\d+) seconds$/;
const ENDED = /^test (.+?) \.\.\. (ok|FAILED|ignored|bench)\b/;

const DEFAULT_TEST_TIMEOUT_SECONDS = 300;

export function testTimeoutSeconds(env = process.env) {
  const value = Number(env.LATTICE_GPUI_TEST_TIMEOUT_SECONDS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TEST_TIMEOUT_SECONDS;
}

/**
 * Watches libtest output fed in through `line`. `onTimeout(name, seconds)` is
 * called once, for the first test past `limitSeconds`.
 */
export function watchTestOutput({ limitSeconds, onTimeout, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const timers = new Map();
  let fired = false;
  return {
    line(text) {
      // Uncoloured: libtest colours only a terminal, and this reads a pipe.
      const plain = text.trimEnd();
      const running = RUNNING.exec(plain);
      if (running) {
        const [, name, after] = running;
        if (timers.has(name) || fired) return;
        const left = Math.max(0, limitSeconds - Number(after)) * 1000;
        timers.set(
          name,
          setTimer(() => {
            timers.delete(name);
            if (fired) return;
            fired = true;
            onTimeout(name, limitSeconds);
          }, left),
        );
        return;
      }
      const ended = ENDED.exec(plain);
      if (ended && timers.has(ended[1])) {
        clearTimer(timers.get(ended[1]));
        timers.delete(ended[1]);
      }
    },
    stop() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
  };
}
