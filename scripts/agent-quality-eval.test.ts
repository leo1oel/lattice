import { describe, expect, it } from "vitest";
import { evaluateTrace, parseTrace } from "./agent-quality-eval.mjs";

const base = (records: object[]) => ({ schemaVersion: 1, records });
describe("agent quality eval", () => {
  it("accepts fetched evidence, brokered bibliography and associated compile", () => {
    const ids = { threadId: "t", turnId: "u" };
    const evidenceId = "a".repeat(64);
    expect(evaluateTrace(base([
      { type: "turn.context", ...ids, allowedPaths: ["main.tex", "refs.bib"] },
      { type: "tool", ...ids, tool: { name: "fetch_paper", status: "success", evidenceAccess: "fulltext", evidenceIds: [evidenceId] } },
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [evidenceId] } },
      { type: "checkpoint", ...ids, status: "success", checkpointRef: "cp", files: [{ path: "main.tex" }, { path: "refs.bib" }] },
      { type: "compile", ...ids, checkpointRef: "cp", success: true },
    ])).pass).toBe(true);
  });
  it("finds every research policy violation while ignoring sensitive content fields", () => {
    const ids = { threadId: "t", turnId: "u" };
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
    const ids = { threadId: "t", turnId: "u" };
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
      expect(evaluateTrace(base(records)).violations.map((item: { rule: string }) => item.rule))
        .toContain("allowed-paths");
    }
  });
  it("does not let fetching one source justify citing another", () => {
    const ids = { threadId: "t", turnId: "u" };
    const paperA = "a".repeat(64);
    const paperB = "b".repeat(64);
    const result = evaluateTrace(base([
      { type: "turn.context", ...ids, allowedPaths: ["references.bib"] },
      { type: "tool", ...ids, tool: { name: "fetch_paper", status: "success", evidenceAccess: "fulltext", evidenceIds: [paperA] } },
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [paperB] } },
    ]));
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: "metadata-not-evidence" }),
    ]);
  });
  it("accepts a provider file read only when its cached paper identifier matches", () => {
    const ids = { threadId: "t", turnId: "u" };
    const evidenceId = "a".repeat(64);
    expect(evaluateTrace(base([
      { type: "turn.context", ...ids, allowedPaths: ["references.bib"] },
      { type: "tool", ...ids, tool: { name: "Read", status: "success", evidenceAccess: "fulltext", evidenceIds: [evidenceId] } },
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [evidenceId] } },
    ])).pass).toBe(true);
  });
  it("rejects untrusted or malformed evidence claims", () => {
    const ids = { threadId: "t", turnId: "u" };
    const evidenceId = "a".repeat(64);
    const untrustedRead = evaluateTrace(base([
      { type: "turn.context", ...ids, allowedPaths: ["references.bib"] },
      { type: "tool", ...ids, tool: { name: "Read", status: "success", evidenceIds: [evidenceId] } },
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [evidenceId] } },
    ]));
    expect(untrustedRead.violations.map((item: { rule: string }) => item.rule))
      .toContain("metadata-not-evidence");

    const selfAttestingCitation = evaluateTrace(base([
      { type: "turn.context", ...ids, allowedPaths: ["references.bib"] },
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceAccess: "fulltext", evidenceIds: [evidenceId] } },
    ]));
    expect(selfAttestingCitation.violations.map((item: { rule: string }) => item.rule))
      .toContain("metadata-not-evidence");

    const malformed = evaluateTrace(base([
      { type: "tool", ...ids, tool: { name: "cite", status: "success", evidenceIds: [evidenceId, "invalid"] } },
    ]));
    expect(malformed.violations.map((item: { rule: string }) => item.rule)).toContain("schema");
  });
  it("rejects correlation identifiers that could collide across turns", () => {
    const result = evaluateTrace(base([
      { type: "turn.started", threadId: "a", turnId: "b\0c" },
      { type: "turn.started", threadId: "a\0b", turnId: "c" },
    ]));
    expect(result.violations.map((item: { rule: string }) => item.rule))
      .toEqual(["schema", "schema"]);
  });
  it("treats a stop request as terminal and correlates recovery by checkpoint count", () => {
    const ids = { threadId: "t", turnId: "u" };
    const result = evaluateTrace(base([
      { type: "session", ...ids, action: "recovery", checkpointTurnCount: 3 },
      { type: "session", ...ids, action: "recovered", checkpointTurnCount: 3 },
      { type: "stop", ...ids, status: "requested" },
      { type: "tool", ...ids, tool: { name: "read_paper", status: "success" } },
    ]));
    expect(result.violations.map((item: { rule: string }) => item.rule)).toEqual(["stop-terminal"]);
  });
});
