/**
 * Workspace Markdown index: parsed pages plus the wiki-link page search.
 */
import type { FileNode } from "../../app-types";
import { PageSearchIndex } from "../../project/workspace-search";
import { scanHeadings, type HeadingEntry } from "./markdown-headings";

export type MarkdownDocEntry = {
  path: string;
  docName: string;
  title: string;
  headings: HeadingEntry[];
  content: string;
};

const MARKDOWN_EXTENSION = /\.(?:md|mdx)$/i;

function normalizePath(path: string): string {
  const output: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "..") output.pop();
    else if (part && part !== ".") output.push(part);
  }
  return output.join("/");
}

const docKey = (path: string) => normalizePath(path).replace(MARKDOWN_EXTENSION, "").toLowerCase();

function markdownFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => [
    ...markdownFiles(node.children),
    ...(MARKDOWN_EXTENSION.test(node.path)
      && node.kind !== "directory"
      && node.contentKind !== "directory"
      && node.contentKind !== "binary" ? [node] : []),
  ]);
}

function parseDocument(path: string, content: string): MarkdownDocEntry {
  const normalizedPath = normalizePath(path);
  const docName = normalizedPath.replace(MARKDOWN_EXTENSION, "");
  const lines = content.split("\n");
  const isDelimiter = (line = "") => line.replace(/\r$/, "") === "---";
  // Skip a leading frontmatter block; an unterminated one hides the whole body.
  let body = lines;
  if (isDelimiter(lines[0])) {
    const end = lines.findIndex((line, index) => index > 0 && isDelimiter(line));
    body = end < 0 ? [] : lines.slice(end + 1);
  }
  const headings = scanHeadings(body).filter((heading) => heading.text && heading.slug);
  const title = headings.find((heading) => heading.level === 1)?.text ?? docName.split("/").pop() ?? docName;
  return { path: normalizedPath, docName, title, headings, content };
}

export class MarkdownWorkspaceIndex {
  private docs: MarkdownDocEntry[] = [];
  private readonly pageSearch = new PageSearchIndex();
  private pendingFiles: FileNode[] | null = null;
  private updatePromise: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly readFile: (path: string) => Promise<string>) {}

  /** Rebuild from a project snapshot's file tree. Reads every .md/.mdx text file. Coalesces concurrent calls; last snapshot wins. */
  update(files: FileNode[]): Promise<void> {
    this.pendingFiles = files;
    this.updatePromise ??= this.runUpdates().finally(() => {
      this.updatePromise = null;
    });
    return this.updatePromise;
  }

  private async runUpdates(): Promise<void> {
    while (this.pendingFiles) {
      const files = markdownFiles(this.pendingFiles);
      this.pendingFiles = null;
      const docs = await Promise.all(files.map((file) => this.readFile(file.path)
        .then((content) => parseDocument(file.path, content))
        .catch(() => null)));
      this.replaceDocs(docs.filter((doc) => doc !== null));
    }
  }

  /** Feed a live in-editor content change without re-reading from disk. */
  noteDocumentContent(path: string, content: string): void {
    const normalizedPath = normalizePath(path).toLowerCase();
    const index = this.docs.findIndex((candidate) => candidate.path.toLowerCase() === normalizedPath);
    // Opening an already indexed file must not rebuild the complete search
    // corpus. The visual editor reports its initial text on mount, so this
    // fast path keeps file switches proportional to the opened document.
    if (index >= 0 && this.docs[index].content === content) return;
    const docs = [...this.docs];
    docs.splice(index < 0 ? docs.length : index, 1, parseDocument(path, content));
    this.replaceDocs(docs);
  }

  /** Ranked page completion for wiki links; an empty query returns the first `limit` docs in source order. */
  searchPages(query: string, limit = 20): MarkdownDocEntry[] {
    if (!query.trim()) return this.docs.slice(0, limit);
    const byName = new Map(this.docs.map((doc) => [doc.docName, doc]));
    return this.pageSearch.search(query, limit).flatMap((page) => byName.get(page.path) ?? []);
  }

  getDoc(docName: string): MarkdownDocEntry | undefined {
    const key = docKey(docName);
    return this.docs.find((doc) => doc.docName.toLowerCase() === key);
  }

  /** Current Markdown source for read-only cross-document projections such as Mirror. */
  contentFor(docName: string): string | undefined {
    return this.getDoc(docName)?.content;
  }

  /**
   * The index is mutated in place and never changes identity, so a consumer
   * that renders index content has to subscribe and take the content itself
   * as its snapshot — see `Mirror` in open-knowledge-app/editor/components/Mirror-host.tsx.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private replaceDocs(docs: MarkdownDocEntry[]): void {
    this.docs = docs;
    // Page search reads names only and keeps the analysis of every page
    // whose name is unchanged, so a publication of one edited document does
    // not re-tokenize the workspace.
    this.pageSearch.update(docs.map((doc) => ({ path: doc.docName, title: doc.title })));
    for (const listener of this.listeners) listener();
  }
}
