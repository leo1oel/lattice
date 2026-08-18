import { describe, expect, it } from "vitest";
import { applyOps, type OtOp } from "./ot-ops";
import { composeOps, transformOps } from "./ot-transform";

/** Apply, asserting the op fits — tests must never silently skip a bad op. */
function apply(document: string, op: OtOp[]): string {
  const result = applyOps(document, op);
  expect(result, `op did not fit: ${JSON.stringify(op)} on ${JSON.stringify(document)}`).not.toBeNull();
  return result as string;
}

/**
 * The property the whole feature rests on: two people edit the same document
 * at once, each transforms the other's work, and both end up with the same
 * text. If this fails, concurrent editing corrupts documents.
 */
function expectConvergence(document: string, mine: OtOp[], theirs: OtOp[]) {
  const minePath = apply(apply(document, mine), transformOps(theirs, mine, "right"));
  const theirPath = apply(apply(document, theirs), transformOps(mine, theirs, "left"));
  expect(minePath).toBe(theirPath);
  return minePath;
}

describe("transformOps", () => {
  it("shifts an insert that follows someone else's insert", () => {
    expectConvergence("hello world", [{ p: 11, i: "!" }], [{ p: 0, i: ">> " }]);
  });

  it("orders concurrent inserts at the same spot consistently", () => {
    // Both people type at position 5. Whatever order is chosen, both machines
    // must choose the same one.
    expectConvergence("abcdefgh", [{ p: 5, i: "MINE" }], [{ p: 5, i: "THEIRS" }]);
  });

  it("moves an insert that lands inside deleted text to the deletion point", () => {
    expectConvergence("the quick brown fox", [{ p: 7, i: "X" }], [{ p: 4, d: "quick " }]);
  });

  it("splits a delete around someone else's insert, keeping their text", () => {
    const result = expectConvergence(
      "abcdef",
      [{ p: 1, d: "bcde" }],
      [{ p: 3, i: "KEEP" }],
    );
    expect(result).toBe("aKEEPf");
  });

  it("drops the overlapping part when both delete the same text", () => {
    expectConvergence("abcdefgh", [{ p: 2, d: "cde" }], [{ p: 3, d: "def" }]);
    // Identical deletes: the second becomes a no-op rather than eating more.
    expect(expectConvergence("abcdefgh", [{ p: 2, d: "cde" }], [{ p: 2, d: "cde" }]))
      .toBe("abfgh");
  });

  it("handles a delete entirely before and entirely after another", () => {
    expectConvergence("0123456789", [{ p: 0, d: "01" }], [{ p: 8, d: "89" }]);
    expectConvergence("0123456789", [{ p: 8, d: "89" }], [{ p: 0, d: "01" }]);
  });

  it("handles multi-component operations on both sides", () => {
    expectConvergence(
      "alpha beta gamma",
      [{ p: 0, d: "alpha" }, { p: 0, i: "ALPHA" }],
      [{ p: 11, d: "gamma" }, { p: 11, i: "GAMMA" }],
    );
  });

  it("survives one side deleting everything", () => {
    expectConvergence("some text here", [{ p: 0, d: "some text here" }], [{ p: 5, i: "XX" }]);
  });
});

describe("composeOps", () => {
  it("combines sequential edits into one operation", () => {
    const document = "hello";
    const first: OtOp[] = [{ p: 5, i: " world" }];
    const second: OtOp[] = [{ p: 11, i: "!" }];
    const composed = composeOps(first, second);
    expect(apply(document, composed)).toBe(apply(apply(document, first), second));
  });

  it("merges adjacent typing into a single insert", () => {
    const composed = composeOps([{ p: 0, i: "ab" }], [{ p: 2, i: "cd" }]);
    expect(composed).toEqual([{ p: 0, i: "abcd" }]);
  });

  it("stays correct when the second op deletes elsewhere", () => {
    const document = "0123456789";
    const first: OtOp[] = [{ p: 10, i: "X" }];
    const second: OtOp[] = [{ p: 0, d: "01" }];
    expect(apply(document, composeOps(first, second)))
      .toBe(apply(apply(document, first), second));
  });
});

// ---- Randomised proof ------------------------------------------------------

/** Deterministic PRNG, so a failure is always reproducible from its seed. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const ALPHABET = "abcdefgh\n";

function randomDocument(random: () => number): string {
  const length = Math.floor(random() * 24);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return text;
}

/** A random operation of one to three components, valid against `document`. */
function randomOp(random: () => number, document: string): OtOp[] {
  const op: OtOp[] = [];
  let current = document;
  const components = 1 + Math.floor(random() * 3);
  for (let index = 0; index < components; index += 1) {
    if (current.length > 0 && random() < 0.5) {
      const position = Math.floor(random() * current.length);
      const length = 1 + Math.floor(random() * Math.min(4, current.length - position));
      const component = { p: position, d: current.slice(position, position + length) };
      op.push(component);
      current = current.slice(0, position) + current.slice(position + length);
    } else {
      const position = Math.floor(random() * (current.length + 1));
      const size = 1 + Math.floor(random() * 3);
      let text = "";
      for (let count = 0; count < size; count += 1) {
        text += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }
      op.push({ p: position, i: text });
      current = current.slice(0, position) + text + current.slice(position);
    }
  }
  return op;
}

describe("convergence under random concurrent edits", () => {
  // Several seeds, because each explores a different corner of the space —
  // overlapping deletes, inserts inside deletions, ops that split in two.
  it.each([0x5eed, 0xbeef, 0x1234, 0xfeed, 0xabcd])("converges (seed %i)", (seed) => {
    const random = makeRandom(seed);
    for (let round = 0; round < 4000; round += 1) {
      const document = randomDocument(random);
      const mine = randomOp(random, document);
      const theirs = randomOp(random, document);
      const minePath = applyOps(applyOps(document, mine) as string, transformOps(theirs, mine, "right"));
      const theirPath = applyOps(applyOps(document, theirs) as string, transformOps(mine, theirs, "left"));
      if (minePath !== theirPath) {
        throw new Error(
          `diverged on round ${round}\n`
          + `document: ${JSON.stringify(document)}\n`
          + `mine:     ${JSON.stringify(mine)}\n`
          + `theirs:   ${JSON.stringify(theirs)}\n`
          + `mine →    ${JSON.stringify(minePath)}\n`
          + `theirs →  ${JSON.stringify(theirPath)}`,
        );
      }
    }
  });

  it("composes a run of sequential edits into an equivalent operation", () => {
    const random = makeRandom(0xc0ffee);
    for (let round = 0; round < 2000; round += 1) {
      const document = randomDocument(random);
      const first = randomOp(random, document);
      const middle = applyOps(document, first) as string;
      const second = randomOp(random, middle);
      const stepwise = applyOps(middle, second);
      const composed = applyOps(document, composeOps(first, second));
      expect(composed, `round ${round}`).toBe(stepwise);
    }
  });
});
