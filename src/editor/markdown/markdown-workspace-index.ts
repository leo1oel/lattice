/**
 * Workspace Markdown index built on the vendored Open Knowledge search engine.
 */
import type { FileNode } from "../../app-types";
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
  updateWorkspaceSearchCorpus,
  type WorkspaceSearchCorpus,
} from "../../open-knowledge-core/search/workspace-search.ts";
import { createCodeFenceTracker } from "../../open-knowledge-core/utils/code-fence-tracker.ts";
import { scanHeadingLine } from "../../open-knowledge-core/utils/heading-scan.ts";
import type { HeadingEntry } from "../../open-knowledge-core/utils/slug.ts";
import { expandTagToHierarchy } from "../../open-knowledge-core/utils/tag-rollup.ts";

/** One explicit frontmatter tag with its document-membership count. */
export type TagSummaryEntry = {
  name: string;
  count: number;
  isLeaf: boolean;
};

export type MarkdownDocEntry = {
  path: string;
  docName: string;
  title: string;
  headings: HeadingEntry[];
  outgoing: { target: string; anchor: string | null; kind: "wiki" | "md" }[];
  /** Bare values from YAML frontmatter `tags:`, deduped and case-sensitive. */
  tags: string[];
};

type IndexedDoc = MarkdownDocEntry & { content: string };

const MARKDOWN_EXTENSION = /\.(?:md|mdx)$/i;
const WIKI_LINK_PATTERN = /\[\[([^[\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g;

function normalizePath(path: string): string {
  const output: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

function docNameForPath(path: string): string {
  return normalizePath(path).replace(MARKDOWN_EXTENSION, "");
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function markdownFiles(files: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.children.length > 0) visit(node.children);
      if (
        MARKDOWN_EXTENSION.test(node.path) &&
        node.kind !== "directory" &&
        node.contentKind !== "directory" &&
        node.contentKind !== "binary"
      ) {
        result.push(node);
      }
    }
  };
  visit(files);
  return result;
}

function bodyLines(content: string): string[] {
  const lines = content.split("\n");
  if ((lines[0] ?? "").replace(/\r$/, "") !== "---") return lines;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.replace(/\r$/, "") === "---",
  );
  return end < 0 ? [] : lines.slice(end + 1);
}

/**
 * Frontmatter `tags:` entries admit a leading digit (`2026` is a legitimate
 * year tag). The YAML list is explicit and never round-trips through prose.
 * Mirrors upstream core's `frontmatter/tags.ts` contract.
 */
const FRONTMATTER_TAG_VALUE_RE = /^[a-zA-Z0-9][\w/-]*$/;

function pushFrontmatterTag(out: string[], raw: string): void {
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, "").replace(/^#/, "");
  if (FRONTMATTER_TAG_VALUE_RE.test(cleaned)) out.push(cleaned);
}

/**
 * Lightweight `tags:` extractor for the YAML frontmatter block. Handles the
 * three shapes authors actually write — flow list (`tags: [a, b/c]`),
 * single-tag scalar (`tags: foo`), and dash list — without taking on a full
 * YAML parser (upstream core uses `frontmatter/tags.ts` + a YAML codec; this
 * index is a line scanner by design). Comment tails (`tags: a # note`) are
 * NOT stripped; an entry that fails the value regex is dropped.
 */
function frontmatterTags(content: string): string[] {
  const lines = content.split("\n");
  if ((lines[0] ?? "").replace(/\r$/, "") !== "---") return [];
  const end = lines.findIndex(
    (line, index) => index > 0 && line.replace(/\r$/, "") === "---",
  );
  if (end < 0) return [];
  const block = lines.slice(1, end);
  const tags: string[] = [];
  for (let index = 0; index < block.length; index += 1) {
    const match = block[index].match(/^tags:\s*(.*)$/);
    if (!match) continue;
    const rest = match[1].trim();
    if (rest.startsWith("[")) {
      const inner = rest.replace(/^\[/, "").replace(/\]\s*$/, "");
      for (const part of inner.split(",")) pushFrontmatterTag(tags, part);
    } else if (rest) {
      pushFrontmatterTag(tags, rest);
    } else {
      for (let cursor = index + 1; cursor < block.length; cursor += 1) {
        const item = block[cursor].match(/^\s*-\s+(.+?)\s*$/);
        if (!item) break;
        pushFrontmatterTag(tags, item[1]);
      }
    }
    break;
  }
  return tags;
}

function parseDocument(path: string, content: string): IndexedDoc {
  const normalizedPath = normalizePath(path);
  const docName = docNameForPath(normalizedPath);
  const headings: HeadingEntry[] = [];
  const outgoing: MarkdownDocEntry["outgoing"] = [];
  const tags = new Set(frontmatterTags(content));
  const slugCounts = new Map<string, number>();
  const isInCodeFence = createCodeFenceTracker();

  for (const line of bodyLines(content)) {
    const fenced = isInCodeFence(line);
    if (!fenced) {
      const heading = scanHeadingLine(line, slugCounts);
      if (heading) headings.push(heading);
    }
    if (fenced) continue;

    for (const match of line.matchAll(WIKI_LINK_PATTERN)) {
      outgoing.push({
        target: match[1].trim(),
        anchor: match[2]?.trim() || null,
        kind: "wiki",
      });
    }
    for (const match of line.matchAll(MARKDOWN_LINK_PATTERN)) {
      const rawDestination = match[1];
      if (/^[a-z][a-z\d+.-]*:/i.test(rawDestination) || rawDestination.startsWith("/")) continue;
      const [destination, fragment] = rawDestination.split("#", 2);
      if (!MARKDOWN_EXTENSION.test(destination)) continue;
      const directory = normalizedPath.includes("/")
        ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/"))
        : "";
      outgoing.push({
        target: docNameForPath(`${directory}/${destination}`),
        anchor: fragment || null,
        kind: "md",
      });
    }
  }

  const title = headings.find((heading) => heading.level === 1)?.text ?? basename(docName);
  return { path: normalizedPath, docName, title, headings, outgoing, tags: [...tags], content };
}

export class MarkdownWorkspaceIndex {
  private indexedDocs: IndexedDoc[] = [];
  private corpus: WorkspaceSearchCorpus = createWorkspaceSearchCorpus([]);
  private pendingFiles: FileNode[] | null = null;
  private updatePromise: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private currentRevision = 0;

  constructor(private readonly readFile: (path: string) => Promise<string>) {}

  /** Rebuild from a project snapshot's file tree. Reads every .md/.mdx text file. Coalesces concurrent calls; last snapshot wins. */
  update(files: FileNode[]): Promise<void> {
    this.pendingFiles = files;
    if (!this.updatePromise) {
      this.updatePromise = this.runUpdates().finally(() => {
        this.updatePromise = null;
      });
    }
    return this.updatePromise;
  }

  private async runUpdates(): Promise<void> {
    while (this.pendingFiles) {
      const files = this.pendingFiles;
      this.pendingFiles = null;
      const docs = (
        await Promise.all(
          markdownFiles(files).map(async (file) => {
            try {
              return parseDocument(file.path, await this.readFile(file.path));
            } catch {
              return null;
            }
          }),
        )
      ).filter((doc): doc is IndexedDoc => doc !== null);
      this.replaceDocs(docs);
    }
  }

  /** Feed a live in-editor content change without re-reading from disk. */
  noteDocumentContent(path: string, content: string): void {
    const normalizedPath = normalizePath(path);
    const index = this.indexedDocs.findIndex(
      (candidate) => candidate.path.toLowerCase() === normalizedPath.toLowerCase(),
    );
    // Opening an already indexed file must not rebuild the complete search
    // corpus. The visual editor reports its initial text on mount, so this
    // fast path keeps file switches proportional to the opened document.
    if (index >= 0 && this.indexedDocs[index].content === content) return;
    const doc = parseDocument(normalizedPath, content);
    const docs = [...this.indexedDocs];
    if (index < 0) docs.push(doc);
    else docs[index] = doc;
    this.replaceDocs(docs);
  }

  /** Reuse already-read Markdown sources when warming visual previews. */
  previewDocuments(): Array<{ path: string; content: string }> {
    return this.indexedDocs.map(({ path, content }) => ({ path, content }));
  }

  /** Ranked page completion via the vendored searchWorkspaceCorpus (intent "autocomplete"); empty query returns first `limit` docs in source order. */
  searchPages(query: string, limit = 20): MarkdownDocEntry[] {
    if (!query.trim()) return this.indexedDocs.slice(0, limit);
    const byName = new Map(this.indexedDocs.map((doc) => [doc.docName, doc]));
    return searchWorkspaceCorpus(this.corpus, query, { intent: "autocomplete", limit })
      .map((result) => byName.get(result.document.path))
      .filter((doc): doc is IndexedDoc => doc !== undefined);
  }

  getDoc(docName: string): MarkdownDocEntry | undefined {
    const normalized = docNameForPath(docName).toLowerCase();
    return this.indexedDocs.find((doc) => doc.docName.toLowerCase() === normalized);
  }

  /**
   * Workspace tag summary for explicit frontmatter metadata: one entry per
   * authored tag and per hierarchical rollup prefix (`proj/team` in one doc
   * expands to `proj` + `proj/team`).
   * Counts are doc membership (a tag used twice in one doc counts once);
   * prefix entries carry the cumulative count of every tag under the branch,
   * and `isLeaf` marks entries that were literally authored.
   */
  tagSummaries(): TagSummaryEntry[] {
    const leafCounts = new Map<string, number>();
    for (const doc of this.indexedDocs) {
      for (const tag of doc.tags) {
        leafCounts.set(tag, (leafCounts.get(tag) ?? 0) + 1);
      }
    }
    const rolled = new Map<string, TagSummaryEntry>();
    for (const [tag, count] of leafCounts) {
      for (const prefix of expandTagToHierarchy(tag)) {
        const entry = rolled.get(prefix) ?? { name: prefix, count: 0, isLeaf: false };
        entry.count += count;
        rolled.set(prefix, entry);
      }
      const leaf = rolled.get(tag);
      if (leaf) leaf.isLeaf = true;
    }
    return [...rolled.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Current Markdown source for read-only cross-document projections such as Mirror. */
  contentFor(docName: string): string | undefined {
    const normalized = docNameForPath(docName).toLowerCase();
    return this.indexedDocs.find((doc) => doc.docName.toLowerCase() === normalized)?.content;
  }

  /**
   * How many times the docs have been replaced. For observing that an update
   * happened — not for driving a render.
   *
   * A counter read beside a render-time lookup does not make that lookup
   * observable: it is not an input to it, so memoization (the React Compiler's
   * included) drops it and the view freezes on whatever it resolved first. A
   * consumer that renders index content has to subscribe and take the content
   * itself as its snapshot — see `Mirror` in
   * open-knowledge-app/editor/components/Mirror-host.tsx.
   */
  get revision(): number {
    return this.currentRevision;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  headingsFor(docName: string): HeadingEntry[] {
    return this.getDoc(docName)?.headings ?? [];
  }

  /** Paths of docs whose outgoing links resolve to this docName (wiki targets match docName case-insensitively by full docName or by basename; md links resolve relative paths). */
  backlinksFor(docName: string): string[] {
    const target = docNameForPath(docName).toLowerCase();
    const targetBase = basename(target);
    return this.indexedDocs
      .filter((doc) =>
        doc.outgoing.some((link) => {
          const linked = docNameForPath(link.target).toLowerCase();
          return link.kind === "md"
            ? linked === target
            : linked === target || basename(linked) === targetBase;
        }),
      )
      .map((doc) => doc.path);
  }

  get docs(): readonly MarkdownDocEntry[] {
    return this.indexedDocs;
  }

  private replaceDocs(docs: IndexedDoc[]): void {
    this.indexedDocs = docs;
    const documents = docs.map((doc) =>
      createWorkspaceSearchDocument({
        kind: "page",
        path: doc.docName,
        title: doc.title,
        content: doc.content,
        modifiedTs: 0,
      }),
    );
    // Incremental: a single edited document patches the shared BM25 index
    // instead of re-tokenizing the whole workspace per publication. The
    // updater diffs against the previous corpus itself and falls back to a
    // from-scratch build for bulk changes (project open, branch switches).
    this.corpus = updateWorkspaceSearchCorpus(this.corpus, documents).corpus;
    this.currentRevision += 1;
    for (const listener of this.listeners) listener();
  }
}
