import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decide, defaultCheckout, LABEL, lockHolder, plist } from "./gpui-main-baseline-agent.mjs";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-15T12:00:00Z");
const base = { originSha: "b".repeat(40), latestSha: "a".repeat(40), state: null, now, minIntervalMs: 2 * HOUR, lockHolder: null };

describe("gpui-main-baseline-agent", () => {
  const scratch = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("records main once it has moved past latest.json", () => {
    expect(decide(base).run).toBe(true);
    expect(decide({ ...base, latestSha: null }).run).toBe(true);
    expect(decide({ ...base, latestSha: base.originSha })).toMatchObject({ run: false });
    expect(decide({ ...base, originSha: null })).toMatchObject({ run: false });
  });

  it("coalesces merges into one run every interval", () => {
    const recent = { sha: "c".repeat(40), started: new Date(now - 30 * 60_000).toISOString(), outcome: "recorded" };
    expect(decide({ ...base, state: recent })).toMatchObject({ run: false, reason: expect.stringContaining("90 min") });
    const old = { ...recent, started: new Date(now - 2 * HOUR - 1).toISOString() };
    expect(decide({ ...base, state: old }).run).toBe(true);
    expect(decide({ ...base, state: recent, force: true }).run).toBe(true);
  });

  it("does not retry a commit it already tried until main moves", () => {
    const tried = { sha: base.originSha, started: new Date(now - 5 * HOUR).toISOString(), outcome: "exited 1" };
    expect(decide({ ...base, state: tried })).toMatchObject({ run: false, reason: expect.stringContaining("already tried") });
    expect(decide({ ...base, state: tried, force: true }).run).toBe(true);
  });

  it("leaves the machine to a lane holding the build lock, even when forced", () => {
    expect(decide({ ...base, lockHolder: "123 /lane" })).toMatchObject({ run: false, reason: expect.stringContaining("123 /lane") });
    expect(decide({ ...base, lockHolder: "123 /lane", force: true }).run).toBe(false);
  });

  it("reads a lock as held only while its owner lives", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "baseline-agent-"));
    scratch.push(dir);
    const lock = path.join(dir, "lock");
    expect(lockHolder(lock)).toBeNull();
    mkdirSync(lock);
    expect(lockHolder(lock)).toBe("a process starting up");
    writeFileSync(path.join(lock, "owner"), `${process.pid} /here\n`);
    expect(lockHolder(lock)).toBe(`${process.pid} /here`);
    // Past the highest pid macOS and Linux hand out.
    writeFileSync(path.join(lock, "owner"), "99999999 /gone\n");
    expect(lockHolder(lock)).toBeNull();
  });

  it("writes a launchd agent that ticks from the checkout", () => {
    const text = plist({ node: "/opt/node", checkout: "/c/main & co", every: 15, minHours: 2, log: "/l/agent.log", env: { PATH: "/bin:/usr/bin", EMPTY: undefined } });
    expect(text).toContain(`<string>${LABEL}</string>`);
    expect(text).toContain("<string>/c/main &amp; co/scripts/gpui-main-baseline-agent.mjs</string>");
    expect(text).toContain("<integer>900</integer>");
    expect(text).toContain("<key>PATH</key>");
    expect(text).not.toContain("EMPTY");
    expect(defaultCheckout({ LATTICE_GPUI_BUILD_DIR: "/b" })).toBe(path.join("/b", "main-checkout"));
  });
});
