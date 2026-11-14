import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machineLock } from "./gpui-lock.mjs";

let scratch, dir, lines;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "gpui-lock-"));
  dir = path.join(scratch, "test.lock");
  lines = [];
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const lock = (options = {}) => machineLock(dir, "the test lock", { maxHoldMs: 60 * 60_000, pollMs: 5, waitLogMs: 20, log: (line) => lines.push(line), ...options });
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

function holdAs(owner, writtenSecondsAgo = 0) {
  mkdirSync(dir);
  writeFileSync(path.join(dir, "owner"), `${owner}\n`);
  const at = Date.now() / 1000 - writtenSecondsAgo;
  utimesSync(path.join(dir, "owner"), at, at);
}

function deadPid() {
  return spawnSync("true").pid;
}

describe("machineLock", () => {
  it("logs acquire and release with timestamps and names its owner", async () => {
    const one = lock();
    await one.acquire("here");
    expect(readFileSync(path.join(dir, "owner"), "utf8")).toBe(`${process.pid} here\n`);
    one.release();
    expect(existsSync(dir)).toBe(false);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(ISO);
    expect(lines[0]).toContain(`acquired ${dir} as pid ${process.pid}`);
    expect(lines[1]).toMatch(ISO);
    expect(lines[1]).toMatch(/released .* after holding \d+ s$/);
  });

  it("waits for a live holder and says so again while it waits", async () => {
    // A live pid other than this one: the parent's.
    holdAs(`${process.ppid} someone`);
    const waiting = lock().acquire("me");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const said = lines.filter((line) => line.includes("waiting for the test lock held by"));
    expect(said.length).toBeGreaterThanOrEqual(2);
    expect(said[0]).toMatch(ISO);
    expect(said[0]).toContain(`${process.ppid} someone, for`);
    rmSync(dir, { recursive: true });
    await waiting;
    expect(lines.at(-1)).toContain("acquired");
  });

  it("takes over from a dead holder", async () => {
    holdAs(`${deadPid()} gone`);
    await lock().acquire("next");
    expect(lines.some((line) => /took over .* died holding it/.test(line))).toBe(true);
    expect(readFileSync(path.join(dir, "owner"), "utf8")).toBe(`${process.pid} next\n`);
    expect(readdirSync(scratch)).toEqual(["test.lock"]);
  });

  it("takes over from a live holder past the maximum hold", async () => {
    holdAs(`${process.ppid} stuck`, 120);
    await lock({ maxHoldMs: 60_000 }).acquire("next");
    expect(lines.find((line) => line.includes("took over"))).toContain(`${process.ppid} stuck has held it 2 min 0 s, past the 1 min 0 s limit`);
    expect(readFileSync(path.join(dir, "owner"), "utf8")).toBe(`${process.pid} next\n`);
  });

  it("takes over a directory whose owner was never written", async () => {
    mkdirSync(dir);
    const old = Date.now() / 1000 - 120;
    utimesSync(dir, old, old);
    await lock().acquire("next");
    expect(lines.some((line) => line.includes("no owner was written"))).toBe(true);
  });

  it("leaves a successor's lock alone when released after a takeover", async () => {
    const one = lock();
    await one.acquire("first");
    rmSync(dir, { recursive: true });
    holdAs(`${process.ppid} successor`);
    one.release();
    expect(readFileSync(path.join(dir, "owner"), "utf8")).toBe(`${process.ppid} successor\n`);
    expect(lines.at(-1)).toContain("was taken over while held");
  });
});
