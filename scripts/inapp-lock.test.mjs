// @vitest-environment node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "inapp-lock");

describe.skipIf(process.platform === "win32")("inapp-lock", () => {
  let dir;
  let env;
  const lock = (...args) => spawnSync(script, args, { env, encoding: "utf8" });
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "inapp-lock-"));
    env = { ...process.env, INAPP_LOCK_FILE: path.join(dir, "lock") };
  });
  afterEach(() => {
    lock("--thread", "A", "release");
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs two concurrent holders one after the other", async () => {
    const log = path.join(dir, "log");
    const runner = (name) =>
      new Promise((resolve) => {
        const child = spawn(script, ["--thread", name, "--", "sh", "-c", `echo start ${name} >> "$1"; sleep 0.5; echo end ${name} >> "$1"`, "sh", log], { env });
        child.on("exit", resolve);
      });
    expect(await Promise.all([runner("A"), runner("B")])).toEqual([0, 0]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(lines[0].replace("start", "end"));
    expect(lines[3]).toBe(lines[2].replace("start", "end"));
  });

  it("keeps a hold after the process group that started it is killed", () => {
    const starter = spawn("sh", ["-c", `"${script}" --thread A hold 30; sleep 30`], { env, detached: true });
    const deadline = Date.now() + 10_000;
    while (lock("--wait", "0", "--", "true").status !== 75) {
      if (Date.now() > deadline) throw new Error("the hold never took the lock");
    }
    process.kill(-starter.pid, "SIGKILL");
    expect(lock("--thread", "B", "--wait", "1", "--", "true").status).toBe(75);
    expect(lock("--thread", "A", "release").status).toBe(0);
    expect(lock("--thread", "B", "--wait", "1", "--", "true").status).toBe(0);
  });

  it("keeps the lock when someone deletes and recreates its file", () => {
    expect(lock("--thread", "A", "hold", "30").status).toBe(0);
    rmSync(env.INAPP_LOCK_FILE);
    execFileSync("sleep", ["1.5"]);
    expect(lock("--thread", "B", "--wait", "1", "--", "true").status).toBe(75);
  });
});
