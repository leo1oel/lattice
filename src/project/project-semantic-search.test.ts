import { describe, expect, it } from "vitest";
import type { ProjectFindHit } from "./project-find-dialog";
import {
  DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
  fuseProjectSearchHits,
  semanticQueryEligible,
  type LocalSemanticSearchResponse,
} from "./project-semantic-search";

type Candidate = LocalSemanticSearchResponse["candidates"][number];

const response = (candidates: Candidate[]): LocalSemanticSearchResponse => ({
  status: { ...DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS, state: "ready", modelVersion: "apple-nl-sentence-en-r1" },
  applied: true,
  candidates,
});

const lexicalHit = (path: string, title: string, snippet: string, line: number): ProjectFindHit => (
  { kind: "file", path, title, snippet, line, fileKind: "tex" }
);

const candidate = (path: string, title: string, snippet: string, score: number): Candidate => (
  { path, title, snippet, score, line: 4, kind: "file", fileKind: "tex" }
);

describe("project semantic search fusion", () => {
  it("surfaces a zero-token-overlap document through the workspace-search semantic seam", () => {
    const credentials = candidate(
      "security/credentials.tex",
      "Credential rotation",
      "Expired secrets are re-issued after a failed authorization attempt.",
      0.84,
    );
    expect(fuseProjectSearchHits([], "authentication retries", response([credentials])))
      .toEqual([expect.objectContaining({ path: credentials.path, semantic: true })]);
  });

  it.each([
    ["keeps an exact lexical title ahead of a much stronger semantic-only candidate", "login",
      [lexicalHit("login.tex", "Login", "Login", 1)],
      [candidate("guides/credentials.tex", "Credentials", "Authorization tokens and secrets.", 0.99),
        candidate("login.tex", "Login", "Login", 0.1)],
      ["login.tex", "guides/credentials.tex"]],
    ["uses real RRF ordering to promote a semantically strong body candidate", "telemetry",
      [lexicalHit("observability.tex", "Observability", "telemetry telemetry telemetry metrics", 8),
        lexicalHit("pipeline.tex", "Pipeline", "telemetry ingestion", 6)],
      [candidate("observability.tex", "Observability", "telemetry telemetry telemetry metrics", -0.1),
        candidate("pipeline.tex", "Pipeline", "telemetry ingestion", 0.95)],
      ["pipeline.tex", "observability.tex"]],
  ])("%s", (_case, query, lexical, candidates, expected) => {
    expect(fuseProjectSearchHits(lexical, query, response(candidates)).map((hit) => hit.path)).toEqual(expected);
  });

  it("returns the untouched lexical result when the model is unavailable", () => {
    const lexical = [lexicalHit("main.tex", "main.tex", "exact phrase", 10)];
    const unavailable: LocalSemanticSearchResponse = {
      status: { ...DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS, state: "unavailable", detail: "System model missing" },
      applied: false,
      candidates: [],
    };

    expect(fuseProjectSearchHits(lexical, "exact phrase", unavailable)).toBe(lexical);
    expect(fuseProjectSearchHits(lexical, "exact phrase", null)).toBe(lexical);
  });

  it("does not drop lexical documents when semantic ranking is active", () => {
    const lexical = Array.from({ length: 200 }, (_, index) => (
      lexicalHit(`notes/note-${index}.tex`, `Note ${index}`, "shared lexical phrase", index + 1)
    ));
    lexical.push({
      kind: "paper",
      path: ".research/papers/2401.00001/paper.md",
      title: "A matching paper",
      snippet: "shared lexical phrase in the paper library",
      line: 12,
      fileKind: "md",
    });
    const fused = fuseProjectSearchHits(lexical, "shared lexical phrase", response([
      candidate(lexical[0].path, lexical[0].title, lexical[0].snippet, 0.8),
    ]));

    expect(new Set(fused.map((hit) => hit.path))).toEqual(new Set(lexical.map((hit) => hit.path)));
  });

  it.each([["a", false], ["--", false], ["CRDT", true], ["本地搜索", true]])(
    "gates tiny queries without excluding a useful single concept: %s",
    (query, eligible) => expect(semanticQueryEligible(query)).toBe(eligible),
  );
});
