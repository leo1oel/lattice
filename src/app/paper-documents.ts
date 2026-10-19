/**
 * An imported Paper's two reading files, the full text and the alphaXiv
 * overview, and which of them to show.
 */
import { invoke } from "@tauri-apps/api/core";

export type PaperView = "blog" | "fulltext";

/** The two cached reading files of an imported Paper. */
export function paperDocumentPath(arxivId: string, view: PaperView): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- project-relative file path
  return `.research/papers/${arxivId}/${view === "blog" ? "blog.md" : "paper.md"}`;
}

/**
 * A Paper's full text and overview, read from the local library. They are
 * independent: an arxiv2md conversion can fail while alphaXiv still supplied
 * a useful blog, so keep either readable result rather than letting one
 * rejection discard the other. Library rows stay local on open — refreshing
 * alphaXiv in the foreground made a cached Paper switch wait on the network.
 */
export async function readPaperDocuments(arxivId: string) {
  const [fullText, blog] = await Promise.allSettled([
    invoke<string>("read_paper", { arxivId }),
    invoke<string | null>("read_paper_blog_local", { arxivId }),
  ]);
  return {
    markdown: fullText.status === "fulfilled" ? fullText.value : "",
    blog: blog.status === "fulfilled" ? blog.value : null,
    failure: fullText.status === "rejected" ? fullText.reason as unknown : null,
  };
}

/** Keep full text when it is showing and exists; otherwise prefer the overview. */
export function preferredPaperView(current: PaperView, markdown: string, blog: string | null): PaperView {
  return current === "fulltext" && markdown ? "fulltext" : blog ? "blog" : "fulltext";
}
