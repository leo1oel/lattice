import type { GitStatusEntry as PierreGitStatusEntry } from "@pierre/trees";
import type { GitFileStatus } from "./app-types";

export function toPierreGitStatus(files: readonly GitFileStatus[]): PierreGitStatusEntry[] {
  return files.map(({ path, status }) => {
    switch (status) {
      case "added":
      case "deleted":
      case "ignored":
      case "modified":
      case "renamed":
      case "untracked":
        return { path, status };
      case "copied":
        return { path, status: "added" };
      default:
        return { path, status: "modified" };
    }
  });
}
