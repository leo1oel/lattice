/** The last segment of a `/`-separated path: its file or folder name. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
