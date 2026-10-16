import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ProjectManifest, ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { showError } from "./notify";

/**
 * Add `word` to the open project's spelling list; true when the word is (now)
 * on it. Outside App because its try/catch makes the React Compiler skip the
 * component that holds it. The manifest lands only if the same project is
 * still open when the write returns.
 */
export async function addSpellingWordToProject(word: string, {
  projectRef, setProject,
}: {
  projectRef: RefObject<ProjectSnapshot | null>;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
}): Promise<boolean> {
  const current = projectRef.current;
  const normalized = word.trim();
  if (!current || !normalized) return false;
  const words = current.manifest.spellingWords ?? [];
  if (words.some((existing) => existing.toLocaleLowerCase() === normalized.toLocaleLowerCase())) return true;
  try {
    const manifest = await invoke<ProjectManifest>("set_project_spelling_words", {
      words: [...words, normalized],
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
