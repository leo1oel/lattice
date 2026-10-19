import type { ProjectSnapshot } from "../app-types";

/**
 * Adopt the root document the backend built. It may have promoted the open
 * file to the manifest default (Overleaf's rule); mirroring that locally keeps
 * the outline and the next build's guard in agreement without a re-read.
 */
export function adoptRootDocument(project: ProjectSnapshot, rootDocument: string): ProjectSnapshot {
  const documents = project.manifest.rootDocuments;
  if (documents.some((document) => document.isDefault && document.path === rootDocument)) return project;
  const rootDocuments = documents.map((document) => ({ ...document, isDefault: document.path === rootDocument }));
  if (!documents.some((document) => document.path === rootDocument)) {
    const stem = rootDocument.split("/").pop()?.replace(/\.tex$/i, "");
    rootDocuments.push({ path: rootDocument, name: stem || rootDocument, isDefault: true });
  }
  return { ...project, manifest: { ...project.manifest, rootDocuments } };
}
