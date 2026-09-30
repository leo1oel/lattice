import { describe, expect, it } from "vitest";
import { evaluateFixtures, evaluateTrace, fixturePaths, parseTrace } from "./agent-quality-eval.mjs";

const base = (records: object[]) => ({ schemaVersion: 1, records });
const ids = { threadId: "t", turnId: "u" };
const evidenceId = "a".repeat(64);
const rules = (records: object[]) =>
  evaluateTrace(base(records)).violations.map((item: { rule: string }) => item.rule);
describe("agent quality eval", () => {
  it.each([
    ["fetched evidence, brokered bibliography and associated compile", [
      { type: "turn.context", ...ids, allowedPaths: ["main.tex", "refs.bib"] },
      { type: "tool", ...ids, tool: { name: "fetch_paper", status: "success", evidenceAccess: "fulltext", evidenceProvenance: "normalized-tool-completion", evidenceIds: [evidenceId] } },
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [evidenceId] } },
      { type: "checkpoint", ...ids, status: "success", checkpointRef: "cp", files: [{ path: "main.tex" }, { path: "refs.bib" }] },
      { type: "compile", ...ids, checkpointRef: "cp", success: true },
    ]],
    ["a provider file read only when its cached paper identifier matches", [
      { type: "turn.context", ...ids, allowedPaths: ["references.bib"] },
      { type: "tool", ...ids, tool: { name: "Read", status: "success", evidenceAccess: "fulltext", evidenceProvenance: "normalized-cached-paper-path", evidenceIds: [evidenceId] } },
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [evidenceId] } },
    ]],
  ])("accepts %s", (_label, records) => {
    expect(evaluateTrace(base(records)).pass).toBe(true);
  });
  it("finds every research policy violation while ignoring sensitive content fields", () => {
    const result = evaluateTrace(base([
      { type: "turn.context", ...ids, allowedPaths: ["main.tex", "references.bib"], content: "private manuscript text" },
      { type: "checkpoint", ...ids, status: "success", checkpointRef: "bib", files: [{ path: "references.bib" }] },
      { type: "tool", ...ids, tool: { name: "cite", status: "success" }, prompt: "secret" },
      { type: "checkpoint", ...ids, status: "success", checkpointRef: "tex", files: [{ path: "main.tex" }, { path: "outside.txt" }] },
      { type: "permission", ...ids, requestId: "pending", status: "requested" },
      { type: "session", ...ids, action: "recovery", checkpointRef: "missing" },
      { type: "stop", ...ids, status: "requested" },
      { type: "tool", ...ids, tool: { name: "read_paper", phase: "started", status: "started" } },
    ]));
    expect(result.violations.map((item: { rule: string }) => item.rule).toSorted()).toEqual([
      "allowed-paths",
      "bibliography-broker",
      "compile-after-tex",
      "metadata-not-evidence",
      "permission-resolution",
      "recovery-resume",
      "stop-terminal",
    ]);
  });
  it("rejects malformed envelopes and parses NDJSON", () => {
    expect(evaluateTrace({ schemaVersion: 2, records: [] }).violations[0].rule).toBe("schema");
    expect(parseTrace('{"type":"turn.started","threadId":"t","turnId":"u"}\n').records).toHaveLength(1);
    expect(() => parseTrace("not json")).toThrow(/malformed/);
  });
  it("requires checkpoint scope and rejects traversal in either path set", () => {
    for (const records of [
      [{ type: "checkpoint", ...ids, status: "success", files: [{ path: "main.tex" }] }],
      [{ type: "turn.context", ...ids, allowedPaths: ["main.tex/../../private"] },
        { type: "checkpoint", ...ids, status: "success", files: [{ path: "main.tex" }] }],
      [{ type: "turn.context", ...ids, allowedPaths: ["main.tex"] },
        { type: "checkpoint", ...ids, status: "success", files: [{ path: "main.tex\\..\\private" }] }],
      [{ type: "turn.context", ...ids, allowedPaths: ["/tmp/main.tex"] },
        { type: "checkpoint", ...ids, status: "success", files: [{ path: "main.tex" }] }],
      [{ type: "turn.context", ...ids, allowedPaths: ["file:main.tex"] },
        { type: "checkpoint", ...ids, status: "success", files: [{ path: "main.tex" }] }],
      [{ type: "turn.context", ...ids, allowedPaths: ["sections"] },
        { type: "checkpoint", ...ids, status: "success", files: [{ path: "sections/private.tex" }] }],
      [{ type: "turn.context", ...ids, allowedPaths: ["main.tex"] },
        { type: "checkpoint", ...ids, status: "success", files: [{ path: 42 }] }],
    ]) {
      expect(rules(records)).toContain("allowed-paths");
    }
  });
  it("does not let fetching one source justify citing another", () => {
    const paperB = "b".repeat(64);
    const result = evaluateTrace(base([
      { type: "turn.context", ...ids, allowedPaths: ["references.bib"] },
      { type: "tool", ...ids, tool: { name: "fetch_paper", status: "success", evidenceAccess: "fulltext", evidenceProvenance: "normalized-tool-completion", evidenceIds: [evidenceId] } },
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [paperB] } },
    ]));
    expect(result.violations).toEqual([expect.objectContaining({ rule: "metadata-not-evidence" })]);
  });
  it("rejects untrusted or malformed evidence claims", () => {
    const context = { type: "turn.context", ...ids, allowedPaths: ["references.bib"] };
    const cite = { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [evidenceId] } };
    const tool = (name: string, claim: object = {}) =>
      ({ type: "tool", ...ids, tool: { name, status: "success", ...claim, evidenceIds: [evidenceId] } });
    // An untrusted read, and a read or citation that vouches for itself.
    for (const records of [
      [context, tool("Read"), cite],
      [context, tool("Read", { evidenceAccess: "fulltext" }), cite],
      [context, tool("cite", { evidenceAccess: "fulltext" })],
    ]) {
      expect(rules(records)).toContain("metadata-not-evidence");
    }
    expect(rules([
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [evidenceId, "invalid"] } },
    ])).toContain("schema");
  });
  it("rejects correlation identifiers that could collide across turns", () => {
    expect(rules([
      { type: "turn.started", threadId: "a", turnId: "b\0c" },
      { type: "turn.started", threadId: "a\0b", turnId: "c" },
    ])).toEqual(["schema", "schema"]);
  });
  it("requires a valid checkpoint reference on both sides of compile correlation", () => {
    const checkpoint = { type: "checkpoint", ...ids, status: "success", files: [{ path: "main.tex" }] };
    for (const records of [
      [checkpoint, { type: "compile", ...ids, success: true }],
      [{ ...checkpoint, checkpointRef: "cp" }, { type: "compile", ...ids, success: true }],
      [{ ...checkpoint, checkpointRef: "cp" }, { type: "compile", ...ids, checkpointRef: "other", success: true }],
    ]) {
      expect(rules(records)).toContain("compile-after-tex");
    }
  });
  it("treats a stop request as terminal and correlates recovery by checkpoint count", () => {
    expect(rules([
      { type: "session", ...ids, action: "recovery", checkpointTurnCount: 3 },
      { type: "session", ...ids, action: "recovered", checkpointTurnCount: 3 },
      { type: "stop", ...ids, status: "requested" },
      { type: "tool", ...ids, tool: { name: "read_paper", status: "success" } },
    ])).toEqual(["stop-terminal"]);
  });
  // The committed transcripts in evals/agent-research/ are the eval's own
  // regression corpus: each must still come out the way it declares.
  it("grades every committed eval fixture as its expected outcome", async () => {
    const results = await evaluateFixtures(await fixturePaths());
    expect(new Set(results.map((result) => result.expected))).toEqual(new Set(["pass", "fail"]));
    for (const result of results) expect({ path: result.path, actual: result.actual }).toEqual({ path: result.path, actual: result.expected });
  });
});
