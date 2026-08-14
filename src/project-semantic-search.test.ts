import { describe, expect, it } from "vitest";
import type { ProjectFindHit } from "./project-find-dialog";
import {
  DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
  fuseProjectSearchHits,
  semanticQueryEligible,
  type LocalSemanticSearchResponse,
} from "./project-semantic-search";

function response(
  candidates: LocalSemanticSearchResponse["candidates"],
): LocalSemanticSearchResponse {
  return {
    status: {
      ...DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
      state: "ready",
      modelVersion: "apple-nl-sentence-en-r1",
    },
    applied: true,
    candidates,
  };
}

function candidate(
  path: string,
  title: string,
  snippet: string,
  score: number,
): LocalSemanticSearchResponse["candidates"][number] {
  return { path, title, snippet, score, line: 4, kind: "file", fileKind: "tex" };
}

describe("project semantic search fusion", () => {
  it("surfaces a zero-token-overlap document through the workspace-search semantic seam", () => {
    const fused = fuseProjectSearchHits(
      [],
      "authentication retries",
      response([
        candidate(
          "security/credentials.tex",
          "Credential rotation",
          "Expired secrets are re-issued after a failed authorization attempt.",
          0.84,
        ),
      ]),
    );

    expect(fused).toEqual([
      expect.objectContaining({ path: "security/credentials.tex", semantic: true }),
    ]);
  });

  it("keeps an exact lexical title ahead of a much stronger semantic-only candidate", () => {
    const lexical: ProjectFindHit[] = [{
      kind: "file",
      path: "login.tex",
      title: "Login",
      snippet: "Login",
      line: 1,
      fileKind: "tex",
    }];
    const fused = fuseProjectSearchHits(
      lexical,
      "login",
      response([
        candidate("guides/credentials.tex", "Credentials", "Authorization tokens and secrets.", 0.99),
        candidate("login.tex", "Login", "Login", 0.1),
      ]),
    );

    expect(fused.map((hit) => hit.path)).toEqual(["login.tex", "guides/credentials.tex"]);
  });

  it("uses real RRF ordering to promote a semantically strong body candidate", () => {
    const lexical: ProjectFindHit[] = [
      {
        kind: "file",
        path: "observability.tex",
        title: "Observability",
        snippet: "telemetry telemetry telemetry metrics",
        line: 8,
        fileKind: "tex",
      },
      {
        kind: "file",
        path: "pipeline.tex",
        title: "Pipeline",
        snippet: "telemetry ingestion",
        line: 6,
        fileKind: "tex",
      },
    ];
    const fused = fuseProjectSearchHits(
      lexical,
      "telemetry",
      response([
        candidate("observability.tex", "Observability", lexical[0].snippet, -0.1),
        candidate("pipeline.tex", "Pipeline", lexical[1].snippet, 0.95),
      ]),
    );

    expect(fused.map((hit) => hit.path)).toEqual(["pipeline.tex", "observability.tex"]);
  });

  it("returns the untouched lexical result when the model is unavailable", () => {
    const lexical: ProjectFindHit[] = [{
      kind: "file",
      path: "main.tex",
      title: "main.tex",
      snippet: "exact phrase",
      line: 10,
      fileKind: "tex",
    }];
    const unavailable: LocalSemanticSearchResponse = {
      status: {
        ...DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
        state: "unavailable",
        detail: "System model missing",
      },
      applied: false,
      candidates: [],
    };

    expect(fuseProjectSearchHits(lexical, "exact phrase", unavailable)).toBe(lexical);
    expect(fuseProjectSearchHits(lexical, "exact phrase", null)).toBe(lexical);
  });

  it("does not drop lexical documents when semantic ranking is active", () => {
    const lexical = Array.from({ length: 120 }, (_, index): ProjectFindHit => ({
      kind: "file",
      path: `notes/note-${index}.tex`,
      title: `Note ${index}`,
      snippet: "shared lexical phrase",
      line: index + 1,
      fileKind: "tex",
    }));
    const fused = fuseProjectSearchHits(
      lexical,
      "shared lexical phrase",
      response([candidate(
        lexical[0].path,
        lexical[0].title,
        lexical[0].snippet,
        0.8,
      )]),
    );

    expect(new Set(fused.map((hit) => hit.path))).toEqual(
      new Set(lexical.map((hit) => hit.path)),
    );
  });

  it("gates tiny queries without excluding a useful single concept", () => {
    expect(semanticQueryEligible("a")).toBe(false);
    expect(semanticQueryEligible("--")).toBe(false);
    expect(semanticQueryEligible("CRDT")).toBe(true);
    expect(semanticQueryEligible("本地搜索")).toBe(true);
  });
});
