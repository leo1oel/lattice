import { describe, expect, it } from "vitest";
import { OtDocument } from "./ot";
import { DocumentProof, DocumentProofs, joinDelivery } from "./overleaf-document-proof";
import type { JoinedDoc } from "./overleaf-realtime-model";

/** A document joined at "Shared." v10 whose join delivery the editor took. */
function joined() {
  const doc = new OtDocument("Shared.", 10);
  const proof = new DocumentProof("receipt");
  proof.delivered(proof.deliveryMark());
  return { doc, proof };
}

describe("DocumentProof", () => {
  it("checkpoints Overleaf's text, never typing it has not acknowledged", () => {
    const { doc, proof } = joined();
    proof.typed(doc, "Shared. Mine.");
    expect(proof.checkpoint(doc)).toEqual({ text: "Shared.", version: 10 });
    doc.acknowledge(10);
    expect(proof.checkpoint(doc)).toEqual({ text: "Shared. Mine.", version: 11 });
  });

  it("checkpoints the local copy's text, not Overleaf's, when an operation reached only the document", () => {
    const { doc, proof } = joined();
    proof.typed(doc, "Shared. Mine.");
    // Arrives while the document drains off screen: the disk never takes it.
    proof.remote(doc, [{ p: 0, i: "Theirs. " }], 10);
    expect(doc.text).toBe("Theirs. Shared. Mine.");
    // Until ours is acknowledged, the newest text both grew from is the one before it.
    expect(proof.checkpoint(doc)).toEqual({ text: "Shared.", version: 10 });
    doc.acknowledge(11);
    expect(doc.serverText).toBe("Theirs. Shared. Mine.");
    expect(proof.checkpoint(doc)).toEqual({ text: "Shared. Mine.", version: 12 });
    expect(proof.localCopy(doc)).toEqual({ text: "Shared. Mine.", ops: [{ p: 0, i: "Theirs. " }] });
  });

  it("drops only the operations a delivery carried once the editor takes it", () => {
    const { doc, proof } = joined();
    proof.remote(doc, [{ p: 7, i: " One." }], 10);
    const first = proof.deliveryMark();
    proof.remote(doc, [{ p: 12, i: " Two." }], 11);
    proof.delivered(first);
    expect(proof.localCopy(doc)).toEqual({ text: "Shared. One.", ops: [{ p: 12, i: " Two." }] });
    expect(proof.checkpoint(doc)).toEqual({ text: "Shared. One.", version: 12 });
  });

  it("falls back to the last proven checkpoint once what the local copy holds is unknown", () => {
    const { doc, proof } = joined();
    proof.remote(doc, [{ p: 7, i: " One." }], 10);
    proof.lost(doc);
    expect(proof.localCopy(doc)).toBeNull();
    expect(proof.checkpoint(doc)).toEqual({ text: "Shared.", version: 11 });
    // A later delivery the editor takes makes it known again.
    proof.delivered(proof.deliveryMark());
    expect(proof.checkpoint(doc)).toEqual({ text: "Shared. One.", version: 11 });
  });

  it("never trusts the document again once an operation went out outside it", () => {
    const { doc, proof } = joined();
    proof.invalidate(doc);
    proof.delivered(proof.deliveryMark());
    proof.typed(doc, "Shared. Mine.");
    expect(proof.localCopy(doc)).toBeNull();
    expect(proof.checkpoint(doc)).toEqual({ text: "Shared.", version: 10 });
  });
});

describe("DocumentProofs", () => {
  const answer = (overrides: Partial<JoinedDoc>): JoinedDoc => ({
    text: "Theirs. Shared.", version: 11, comments: [], changes: [], resumed: true, agreed: "Shared.",
    caughtUp: [{ version: 10, ops: [{ p: 0, i: "Theirs. " }], source: "peer" }], ...overrides,
  });
  function parked() {
    const proofs = new DocumentProofs();
    const doc = new OtDocument("Shared.", 10);
    proofs.start(doc, "first");
    proofs.of(doc).delivered(null);
    proofs.park("a", doc, proofs.of(doc).checkpoint(doc));
    return { proofs, doc };
  }

  it("parks only a settled document whose checkpoint is the local copy's text", () => {
    const proofs = new DocumentProofs();
    const doc = new OtDocument("Shared.", 10);
    proofs.start(doc, "first");
    proofs.park("a", doc, proofs.of(doc).checkpoint(doc));
    expect(proofs.parkedAt("a")).toBeUndefined();
    proofs.of(doc).typed(doc, "Shared. Mine.");
    proofs.park("a", doc, proofs.of(doc).checkpoint(doc));
    expect(proofs.parkedAt("a")).toBeUndefined();
    doc.acknowledge(10);
    proofs.park("a", doc, proofs.of(doc).checkpoint(doc));
    expect(proofs.parkedAt("a")).toBe(11);
  });

  it("resumes from a replay that lands exactly on Overleaf's text, carrying the local copy forward", () => {
    const { proofs, doc } = parked();
    expect(proofs.resume("a", answer({}), "me", "second")).toBe(doc);
    expect(proofs.of(doc).localCopy(doc)).toEqual({ text: "Shared.", ops: [{ p: 0, i: "Theirs. " }] });
    expect(proofs.of(doc).receipt).toBe("second");
    expect(proofs.parkedAt("a")).toBeUndefined();
  });

  it.each([
    ["the server could not replay", { resumed: false, caughtUp: [] }],
    ["a sync moved the checkpoint", { agreed: "Synced." }],
    ["the replay ends short of the server's version", { version: 12 }],
    ["the replay skips a version", { caughtUp: [{ version: 11, ops: [{ p: 0, i: "Theirs. " }], source: "peer" }] }],
  ] as [string, Partial<JoinedDoc>][])("starts over when %s", (_label, overrides) => {
    const { proofs } = parked();
    expect(proofs.resume("a", answer(overrides), "me", "second")).toBeNull();
    expect(proofs.parkedAt("a")).toBeUndefined();
  });
});

describe("joinDelivery", () => {
  const none = { replacedText: null, local: null, heldShared: null, agreed: null };
  it.each([
    ["over a copy a reject left stale", { ...none, replacedText: "stale", local: { text: "l", ops: [] } }, { base: "stale" }],
    ["forward from a resumed local copy", { ...none, local: { text: "l", ops: [{ p: 0, i: "x" }] } }, { base: "l", ops: [{ p: 0, i: "x" }], carryTyping: true }],
    ["merged from a held document's local copy", { ...none, heldShared: "h" }, { base: "h", carryTyping: true }],
    ["from the agreed text when Overleaf moved on", { ...none, agreed: "a" }, { base: "a" }],
    ["as it is when Overleaf still holds the agreed text", { ...none, agreed: "text" }, { base: "text", carryTyping: true }],
    ["as it is with nothing agreed", none, { base: "text", carryTyping: false }],
  ] as [string, Parameters<typeof joinDelivery>[1], ReturnType<typeof joinDelivery>][])("delivers %s", (_label, from, expected) => {
    expect(joinDelivery("text", from)).toEqual(expected);
  });
});
