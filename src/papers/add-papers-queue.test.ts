import { afterEach, describe, expect, it } from "vitest";
import { addQueueRunning, clearAddQueue, getAddQueue, runAddQueue } from "./add-papers-queue";

afterEach(() => clearAddQueue());

describe("runAddQueue", () => {
  it("drops the batch when its project closes, so no row stays waiting", async () => {
    let open = true;
    let release!: () => void;
    const items = [1, 2, 3].map((n) => ({ id: `p${n}`, input: `10.1/${n}`, label: `Paper ${n}` }));
    const run = runAddQueue(items, () => new Promise((resolve) => {
      release = () => resolve(undefined);
    }), () => open);
    expect(getAddQueue().map((item) => item.state)).toEqual(["adding", "waiting", "waiting"]);
    // The writer switches project while the first paper imports; its import
    // answers as superseded.
    open = false;
    release();
    await run;
    expect(addQueueRunning()).toBe(false);
    expect(getAddQueue()).toEqual([]);
  });

  it("keeps a finished batch while its project is open", async () => {
    const items = [{ id: "p1", input: "10.1/1", label: "Paper 1" }];
    await runAddQueue(items, async () => ({ citationKey: "a2020" }), () => true);
    expect(getAddQueue()).toMatchObject([{ id: "p1", state: "added", citationKey: "a2020" }]);
  });
});
