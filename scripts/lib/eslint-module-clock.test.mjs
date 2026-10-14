import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { moduleClock } from "./eslint-module-clock.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { sourceType: "module" } });
const error = { messageId: "moduleClock" };

tester.run("lattice/module-clock", moduleClock, {
  valid: [
    // Read when the test runs, beside the code it is compared with.
    `it("groups by day", () => { const now = Date.now(); render(now); });`,
    `const at = () => new Date();`,
    `function stamp() { return Date.now(); }`,
    `class Clock { now = Date.now(); }`,
    // A Date from a fixed value never moves.
    `const EPOCH = new Date("2026-10-13T12:00:00Z");`,
    `const START = new Date(0);`,
    // Pinned: the file sets the system time itself.
    `const NOW = Date.now(); beforeEach(() => { vi.setSystemTime(NOW); });`,
  ],
  invalid: [
    { code: `const NOW = Date.now();`, errors: [error] },
    { code: `const fixture = { startTs: Date.now() - 120000 };`, errors: [error] },
    { code: `const TODAY = new Date();`, errors: [error] },
    { code: `export const NOW = Date.now(); describe("x", () => {});`, errors: [error] },
    // Fake timers without a pinned time leave the module value unpinned.
    { code: `const NOW = Date.now(); beforeEach(() => { vi.useFakeTimers(); });`, errors: [error] },
  ],
});
