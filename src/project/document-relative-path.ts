/**
 * Where a path written in a document points inside the project: relative to
 * the document's folder, or to the project root when it starts with `/`.
 * Nothing is returned for a URL with a scheme, a protocol-relative `//` URL,
 * or a path that climbs out of the project; the result has no leading slash.
 * `path` is already decoded, so `?` and `#` are part of the file name.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
export function documentRelativeProjectPath(path: string, documentPath: string): string | null {
  const target = path.replace(/\\/g, "/");
  if (!target || target.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(target)) return null;
  const parts = target.startsWith("/") ? [] : documentPath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (!parts.pop()) return null;
  }
  return parts.length ? parts.join("/") : null;
}
