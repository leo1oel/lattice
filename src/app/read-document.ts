import { invoke } from "@tauri-apps/api/core";
import { documentFontsReady } from "../lib/document-fonts";

/** A file's mtime on disk; null when it is missing or could not be read. */
export async function readDiskMtime(path: string): Promise<number | null> {
  try {
    const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", { path });
    return stat.exists ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * A project file's text for the canvas to open, read alongside the faces it
 * is drawn in, so its first frame is not drawn in a fallback (see
 * document-fonts.ts).
 */
export async function readDocumentText(path: string, projectRoot: string | undefined): Promise<string> {
  const [text] = await Promise.all([invoke<string>("read_project_file", { path, projectRoot }), documentFontsReady()]);
  return text;
}
