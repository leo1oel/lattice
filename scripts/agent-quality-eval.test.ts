import { describe, expect, it } from "vitest";
import { evaluateTrace, parseTrace } from "./agent-quality-eval.mjs";

const base = (records: object[]) => ({ schemaVersion: 1, records });
describe("agent quality eval", () => {
  it("accepts fetched evidence, brokered bibliography and associated compile", () => {
    const ids = { threadId: "t", turnId: "u" };
    expect(evaluateTrace(base([
      { type: "turn.context", ...ids, allowedPaths: ["main.tex", "refs.bib"] },
      { type: "tool", ...ids, tool: { name: "fetch_paper", status: "success" } },
      { type: "tool", ...ids, tool: { name: "cite", status: "success" } },
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
