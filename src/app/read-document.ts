import { invoke } from "@tauri-apps/api/core";
import { documentFontsReady } from "../lib/document-fonts";

/** What `stat_project_file` reports (project/tree.rs `ProjectFileStat`). */
export type DiskStat = { exists: boolean; mtimeMs: number; size: number; fileId: string };

/**
 * One version of a file on disk. Any field changing makes another version: a
 * restored backup (`mv`, `cp -p`, `rsync -a`, an unzip, Time Machine) brings
 * an older mtime back, so "newer than the last one seen" would miss it.
 * `fileId` is the file itself (device and inode), which a rename keeps.
 */
export type DiskVersion = Pick<DiskStat, "mtimeMs" | "size" | "fileId">;

/** Read whatever version is on disk next: no file matches it. */
export const UNREAD_DISK_VERSION: DiskVersion = { mtimeMs: -1, size: -1, fileId: "" };

export const sameDiskVersion = (a: DiskVersion, b: DiskVersion) => (
  a.mtimeMs === b.mtimeMs && a.size === b.size && a.fileId === b.fileId
);

/** A file's version on disk; null when it is missing or could not be read. */
export async function readDiskVersion(path: string): Promise<DiskVersion | null> {
  try {
    const stat = await invoke<DiskStat>("stat_project_file", { path });
    return stat.exists ? stat : null;
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
