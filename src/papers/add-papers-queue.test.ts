import { afterEach, describe, expect, it } from "vitest";
import { addQueueRunning, cancelAddQueue, clearAddQueue, getAddQueue, retryAddItem, runAddQueue, type PaperAddOutcome } from "./add-papers-queue";

afterEach(() => clearAddQueue());

describe("runAddQueue", () => {
  it("drops the batch when its project closes, so no row stays waiting", async () => {
    let open = true;
    let release!: () => void;
    const items = [1, 2, 3].map((n) => ({ id: `p${n}`, input: `10.1/${n}`, label: `Paper ${n}` }));
    const run = runAddQueue(items, () => new Promise((resolve) => {
      release = () => resolve(undefined);
    }), () => open, 1);
    expect(getAddQueue().map((item) => item.state)).toEqual(["adding", "waiting", "waiting"]);
    // The writer switches project while the first paper imports; its import
    // answers as superseded.
    open = false;
    release();
    await run;
    expect(addQueueRunning()).toBe(false);
    expect(getAddQueue()).toEqual([]);
  });

  it("drops a one-paper batch whose project closes while it imports", async () => {
    let open = true;
    let release!: () => void;
    const items = [{ id: "p1", input: "10.1/1", label: "Paper 1" }];
    const run = runAddQueue(items, () => new Promise((resolve) => {
      release = () => resolve({ citationKey: "a2020" });
    }), () => open);
    // The writer closes the sheet and switches project mid-import; clearing
    // while the batch runs keeps its rows.
    clearAddQueue();
    open = false;
    release();
    await run;
    // Before, the old project's "added" row reached the next project's sheet.
    expect(getAddQueue()).toEqual([]);
  });

  it("keeps a finished batch while its project is open", async () => {
    const items = [{ id: "p1", input: "10.1/1", label: "Paper 1" }];
    await runAddQueue(items, async () => ({ citationKey: "a2020" }), () => true);
    expect(getAddQueue()).toMatchObject([{ id: "p1", state: "added", citationKey: "a2020" }]);
  });

  it("imports a bounded few at once, and a failure holds back none of the others", async () => {
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `p${n}`, input: `10.1/${n}`, label: `Paper ${n}` }));
    const answers = new Map<string, { resolve: (outcome: PaperAddOutcome) => void; reject: (reason: Error) => void }>();
    let peak = 0;
    const run = runAddQueue(items, (item) => new Promise((resolve, reject) => {
      answers.set(item.input, { resolve, reject });
      peak = Math.max(peak, answers.size);
    }), () => true, 4);
    expect(getAddQueue().map((item) => item.state)).toEqual(["adding", "adding", "adding", "adding", "waiting", "waiting"]);
    // The first fails; the next waiting paper starts at once, and the others
    // finish in whatever order their lookups answer.
    answers.get("10.1/1")!.reject(new Error("Not found"));
    answers.delete("10.1/1");
    await Promise.resolve();
    await Promise.resolve();
    expect(getAddQueue()[4].state).toBe("adding");
    for (const input of ["10.1/3", "10.1/2", "10.1/5", "10.1/4", "10.1/6"]) {
      await new Promise((tick) => setTimeout(tick));
      answers.get(input)!.resolve({ citationKey: `k${input.slice(-1)}`, alreadyImported: input === "10.1/2" });
      answers.delete(input);
    }
    await run;
    expect(peak).toBe(4);
    expect(addQueueRunning()).toBe(false);
    expect(getAddQueue().map(({ state, citationKey, alreadyImported }) => [state, citationKey, alreadyImported])).toEqual([
      ["failed", undefined, undefined],
      ["added", "k2", true],
      ["added", "k3", false],
      ["added", "k4", false],
      ["added", "k5", false],
      ["added", "k6", false],
    ]);
    expect(getAddQueue()[0].note).toBe("Not found");
  });

  it("retries a failed paper with the batch's importer", async () => {
    let attempts = 0;
    const items = [{ id: "p1", input: "10.1/1", label: "Paper 1" }];
    await runAddQueue(items, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Network down");
      return { citationKey: "a2020", title: "A Paper" };
    }, () => true);
    expect(getAddQueue()[0]).toMatchObject({ state: "failed", note: "Network down" });
    retryAddItem("p1");
    await new Promise((tick) => setTimeout(tick));
    expect(getAddQueue()[0]).toMatchObject({ state: "added", citationKey: "a2020", title: "A Paper" });
    expect(addQueueRunning()).toBe(false);
  });

  it("stops the papers not yet started when the batch is cancelled", async () => {
    const items = [1, 2, 3].map((n) => ({ id: `p${n}`, input: `10.1/${n}`, label: `Paper ${n}` }));
    let release!: () => void;
    const run = runAddQueue(items, () => new Promise((resolve) => {
      release = () => resolve({ citationKey: "a2020" });
    }), () => true, 1);
    cancelAddQueue();
    release();
    await run;
    expect(getAddQueue().map((item) => item.state)).toEqual(["added", "cancelled", "cancelled"]);
  });
});
