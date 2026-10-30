import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ProjectManifest, ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import type { GrammarIgnores } from "../editor/harper-spellcheck";
import { showError } from "./notify";

const NO_IGNORES: GrammarIgnores = { rules: [], sentences: [] };
const ignoresByManifest = new WeakMap<ProjectManifest, GrammarIgnores>();

/**
 * The project's ignored grammar rules and sentences, one object per
 * manifest: the source editor lints again when its identity changes.
 */
export function projectGrammarIgnores(manifest: ProjectManifest): GrammarIgnores {
  const rules = manifest.grammarIgnoredRules ?? [];
  const sentences = manifest.grammarIgnoredSentences ?? [];
  if (rules.length === 0 && sentences.length === 0) return NO_IGNORES;
  let ignores = ignoresByManifest.get(manifest);
  if (!ignores) {
    ignores = { rules, sentences };
    ignoresByManifest.set(manifest, ignores);
  }
  return ignores;
}

/** Write the project's grammar ignores; the manifest lands only if the same project is still open. */
export async function setProjectGrammarIgnores(ignores: GrammarIgnores, {
  projectRef, setProject,
}: {
  projectRef: RefObject<ProjectSnapshot | null>;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
}): Promise<boolean> {
  const current = projectRef.current;
  if (!current) return false;
  try {
    const manifest = await invoke<ProjectManifest>("set_project_grammar_ignores", {
      rules: ignores.rules,
      sentences: ignores.sentences,
    });
    if (projectRef.current?.root === current.root) {
      setProject((snapshot) => snapshot ? { ...snapshot, manifest } : snapshot);
    }
    return true;
  } catch (reason) {
    showError(toMessage(reason));
    return false;
  }
}

/**
 * Ignore one grammar rule or one sentence in the open project; true when it
 * is (now) ignored. Outside the component, like the project dictionary's
 * action, because its try/catch makes the React Compiler skip what holds it.
 */
export async function ignoreGrammarInProject(
  ignore: { rule: string } | { sentence: string },
  project: Parameters<typeof setProjectGrammarIgnores>[1],
): Promise<boolean> {
  const current = project.projectRef.current;
  if (!current) return false;
  const { rules, sentences } = projectGrammarIgnores(current.manifest);
  const next = "rule" in ignore
    ? { rules: rules.includes(ignore.rule) ? rules : [...rules, ignore.rule], sentences }
    : { rules, sentences: sentences.includes(ignore.sentence) ? sentences : [...sentences, ignore.sentence] };
  if (next.rules === rules && next.sentences === sentences) return true;
  return setProjectGrammarIgnores(next, project);
}
