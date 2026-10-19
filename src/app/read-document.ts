import { invoke } from "@tauri-apps/api/core";

/** A file's mtime on disk; null when it is missing or could not be read. */
export async function readDiskMtime(path: string): Promise<number | null> {
  try {
    const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", { path });
    return stat.exists ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}
