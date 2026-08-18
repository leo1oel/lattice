import {
  createWorkspaceSearchDocument,
  searchWorkspaceDocuments,
} from "../open-knowledge-core/search/workspace-search";
import type { ProjectFindHit } from "./project-find-dialog";

type LocalSemanticSearchState =
  | "disabled"
  | "indexing"
  | "ready"
  | "unavailable"
  | "error";

export type LocalSemanticSearchStatus = {
  state: LocalSemanticSearchState;
  detail: string | null;
  modelVersion: string | null;
  indexedFiles: number;
  indexedChunks: number;
  cachedChunks: number;
  totalChunks: number;
  generation: number;
};

type LocalSemanticSearchCandidate = {
  path: string;
  title: string;
  snippet: string;
  line: number;
  score: number;
  kind: "file" | "paper";
  fileKind: string;
};

export type LocalSemanticSearchResponse = {
  status: LocalSemanticSearchStatus;
  applied: boolean;
  candidates: LocalSemanticSearchCandidate[];
};

export const DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS: LocalSemanticSearchStatus = {
  state: "disabled",
  detail: null,
  modelVersion: null,
  indexedFiles: 0,
  indexedChunks: 0,
  cachedChunks: 0,
  totalChunks: 0,
  generation: 0,
};

/** Tiny/punctuation-only inputs stay on the instant lexical path. */
export function semanticQueryEligible(query: string): boolean {
  const normalized = query.trim();
  return normalized.length >= 3 && /[\p{L}\p{N}]/u.test(normalized);
}

/**
 * Fuse the existing FTS candidates with on-device per-document cosine scores
 * through workspace-search's semantic seam. FTS remains the source of exact
 * line hits; semantic-only documents contribute one bounded local snippet.
 * If the model did not actually contribute, return the original array itself
 * so fallback is behavior- and allocation-identical.
 */
export function fuseProjectSearchHits(
  lexicalHits: ProjectFindHit[],
  query: string,
  semantic: LocalSemanticSearchResponse | null,
): ProjectFindHit[] {
  if (!semantic?.applied || semantic.candidates.length === 0) return lexicalHits;

  const lexicalByPath = new Map<string, ProjectFindHit[]>();
  for (const hit of lexicalHits) {
    const hits = lexicalByPath.get(hit.path) ?? [];
    hits.push(hit);
    lexicalByPath.set(hit.path, hits);
  }
  const semanticByPath = new Map(
    semantic.candidates.map((candidate) => [candidate.path, candidate] as const),
  );
  const paths = new Set([...lexicalByPath.keys(), ...semanticByPath.keys()]);
  const documents = [...paths].map((path) => {
    const lexical = lexicalByPath.get(path) ?? [];
    const candidate = semanticByPath.get(path);
    const title = lexical[0]?.title || candidate?.title || path;
    const content = [
      ...new Set([
        ...lexical.map((hit) => hit.snippet),
        ...(candidate?.snippet ? [candidate.snippet] : []),
      ].filter(Boolean)),
    ].join("\n");
    return createWorkspaceSearchDocument({
      kind: "page",
      path,
      title,
      content,
      modifiedTs: 0,
    });
  });
  const scores = new Map(
    semantic.candidates.map((candidate) => [`page:${candidate.path}`, candidate.score] as const),
  );
  const ranked = searchWorkspaceDocuments(documents, query, {
    intent: "full_text",
    ranking: "relevance",
    // Semantic ranking must not make existing lexical documents disappear.
    // The seam sees every FTS path; any internal ranking cap is restored below.
    limit: documents.length,
    semantic: { scores, candidateLimit: semantic.candidates.length },
  });

  const fused: ProjectFindHit[] = [];
  const emittedPaths = new Set<string>();
  for (const result of ranked) {
    const path = result.document.path;
    emittedPaths.add(path);
    const lexical = lexicalByPath.get(path);
    if (lexical?.length) {
      fused.push(...lexical);
    } else {
      const candidate = semanticByPath.get(path);
      if (candidate) {
        fused.push({
          kind: candidate.kind,
          path: candidate.path,
          title: candidate.title,
          snippet: candidate.snippet,
          line: candidate.line,
          fileKind: candidate.fileKind,
          semantic: true,
        });
      }
    }
  }
  // workspace-search intentionally caps its own result set. Preserve any
  // remaining FTS documents in their original lexical order rather than
  // allowing opt-in semantic ranking to hide an existing search result. The
  // backend already bounds lexical and semantic candidates, so preserving all
  // lexical hits remains finite without a second, lower frontend cap.
  for (const [path, lexical] of lexicalByPath) {
    if (emittedPaths.has(path)) continue;
    fused.push(...lexical);
  }
  return fused;
}

export function localSemanticStatusLabel(status: LocalSemanticSearchStatus): string {
  if (status.state === "indexing") {
    return status.totalChunks > 0
      ? `Indexing ${status.totalChunks} local blocks…`
      : "Starting local semantic index…";
  }
  if (status.state === "ready") {
    return `On-device semantic index ready · ${status.indexedFiles} file${status.indexedFiles === 1 ? "" : "s"}`;
  }
  if (status.state === "unavailable" || status.state === "error") {
    return "Semantic search unavailable · showing lexical results";
  }
  return "";
}
