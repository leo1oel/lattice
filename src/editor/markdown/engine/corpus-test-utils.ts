/**
 * The visual engine's test corpus: Lattice's own Markdown (README, docs, the
 * tutorial template, embedded skills) plus the saved-file formats catalogued
 * in docs/visual-editor-spec.md §11, as byte-exact fixtures. Shared by the
 * corpus tests and the differential harness.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import formatFixtures from "./fixtures/lattice-formats.json";

function markdownFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

/* eslint-disable lingui/no-unlocalized-strings -- repository file paths, read by tests only */
export const repositoryDocuments = [
  "README.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  "THIRD_PARTY_NOTICES.md",
  "literature-worker/README.md",
  "src-tauri/templates/tutorial/notes.md",
  ...markdownFiles("docs"),
  ...markdownFiles("src-tauri/src/embedded_skills"),
  ...markdownFiles(".github"),
]
/* eslint-enable lingui/no-unlocalized-strings */
  // The vendoring log describes the code this engine replaces; it is not corpus.
  .filter((path) => !path.endsWith("open-knowledge-updates.md"))
  .map((path) => [path, readFileSync(path, "utf8")] as const);

export const formatDocuments = Object.entries(formatFixtures as Record<string, string>);

export const corpus = [...repositoryDocuments, ...formatDocuments.map(([name, text]) => [`format: ${name}`, text] as const)];
