/**
 * Workspace Markdown index built on the vendored Open Knowledge search engine.
 */
import type { FileNode } from "../../app-types";
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
  updateWorkspaceSearchCorpus,
} from "../../open-knowledge-core/search/workspace-search.ts";
import { createCodeFenceTracker } from "../../open-knowledge-core/utils/code-fence-tracker.ts";
import { scanHeadingLine } from "../../open-knowledge-core/utils/heading-scan.ts";
import type { HeadingEntry } from "../../open-knowledge-core/utils/slug.ts";

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
  const slugCounts = new Map<string, number>();
  const isInCodeFence = createCodeFenceTracker();
  const headings = body.flatMap((line) => {
    const heading = isInCodeFence(line) ? null : scanHeadingLine(line, slugCounts);
    return heading ? [heading] : [];
  });
  const title = headings.find((heading) => heading.level === 1)?.text ?? docName.split("/").pop() ?? docName;
  return { path: normalizedPath, docName, title, headings, content };
}

export class MarkdownWorkspaceIndex {
  private docs: MarkdownDocEntry[] = [];
  private corpus = createWorkspaceSearchCorpus([]);
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

  /** Ranked page completion via the vendored searchWorkspaceCorpus (intent "autocomplete"); empty query returns first `limit` docs in source order. */
  searchPages(query: string, limit = 20): MarkdownDocEntry[] {
    if (!query.trim()) return this.docs.slice(0, limit);
    const byName = new Map(this.docs.map((doc) => [doc.docName, doc]));
    return searchWorkspaceCorpus(this.corpus, query, { intent: "autocomplete", limit })
      .flatMap((result) => byName.get(result.document.path) ?? []);
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
    // Incremental: a single edited document patches the shared BM25 index
    // instead of re-tokenizing the whole workspace per publication. The
    // updater diffs against the previous corpus itself and falls back to a
    // from-scratch build for bulk changes (project open, branch switches).
    this.corpus = updateWorkspaceSearchCorpus(this.corpus, docs.map((doc) => createWorkspaceSearchDocument({
      kind: "page", path: doc.docName, title: doc.title, content: doc.content, modifiedTs: 0,
    }))).corpus;
    for (const listener of this.listeners) listener();
  }
}
