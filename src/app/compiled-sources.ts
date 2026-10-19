import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { flattenProjectPaths, resolveDiagnosticPath, type CompileDiagnostic } from "../build/compile-diagnostics";

/** The text each file had when the build compiled it, keyed by project path. */
export type CompiledSources = ReadonlyMap<string, string>;
export const NO_COMPILED_SOURCES: CompiledSources = new Map();

/**
 * The text a build's diagnostics describe, for every project file they name:
 * the open buffer for the file the writer was in, and the file on disk for the
 * rest (the build compiled those as saved). Without the other files, an error
 * in an included chapter, or any diagnostic of the build a project opens with,
 * never showed in the editor or answered F8 there.
 */
export async function readCompiledSources(
  project: ProjectSnapshot,
  diagnostics: CompileDiagnostic[],
  activeFile: string,
  activeSource: string,
): Promise<CompiledSources> {
  const sources = new Map<string, string>();
  if (activeFile) sources.set(activeFile, activeSource);
  const projectPaths = flattenProjectPaths(project.files ?? []);
  const known = new Set(projectPaths);
  const paths = new Set(diagnostics
    .map((diagnostic) => resolveDiagnosticPath(diagnostic.file, projectPaths))
    .filter((path) => known.has(path) && !sources.has(path)));
  await Promise.all([...paths].map((path) => invoke<string>("read_project_file", { path, projectRoot: project.root })
    .then((text) => { sources.set(path, text); })
    // A file the writer cannot open shows no diagnostics in an editor either.
    .catch(() => undefined)));
  return sources;
}
