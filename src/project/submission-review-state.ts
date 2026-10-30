import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { chunk } from "../lib/lazy-chunk";

/** One thing the backend's review found (`latex/submission_review.rs`), where in the source it is when it is anywhere. */
export type ReviewFinding = {
  check:
    | "authors-shown" | "acknowledgements" | "thanks" | "identifying-link" | "self-citation"
    | "pdf-author" | "type3-font" | "unembedded-font";
  file: string | null;
  line: number | null;
  /** The source line, the link, the name in the metadata or the font. */
  text: string;
};

export type SubmissionReview = {
  /** The conference template the root document loads ("NeurIPS"), if any. */
  venue: string | null;
  /** How that template is set for review; null when its review is not double-blind. */
  mode: "anonymous" | "authors-shown" | "camera-ready" | "unknown" | null;
  /** A compiled PDF was read. */
  pdf: boolean;
  /** That PDF named a font, so its font checks settle anything. */
  fontsRead: boolean;
  findings: ReviewFinding[];
};

/**
 * One review row's result, before it has words: the panel counts these in its
 * verdict at once, while the labels and the rows themselves load in their own
 * chunk. A camera-ready copy has no anonymity rows, since naming its authors
 * is the point; a row about the PDF cannot settle without one (or, for the
 * fonts, without a PDF whose fonts could be read).
 */
export type ReviewRow = {
  id: "authors" | "acknowledgements" | "links" | "self-citation" | "pdf-author" | "type3" | "unembedded";
  ok: boolean | null;
  findings: ReviewFinding[];
};

/** The rows and their labels: only an open checklist with a review to show needs them. */
export const reviewRowsChunk = chunk(() => import("./submission-review"));

type ReadReview = { key: string; review: SubmissionReview | null };

/**
 * The review of the open project, read while the checklist is open and again
 * whenever the project's tree (after a file event) or its last build changes.
 * Answers that arrive for another project, or after the checklist closed,
 * are dropped. The rows' chunk loads alongside, so it is usually in before
 * the answer is.
 */
export function useSubmissionReview(scope: string, wanted: boolean, tree: unknown, build: unknown): SubmissionReview | null {
  const key = wanted ? scope : "";
  const [read, setRead] = useReducer((_: ReadReview | null, next: ReadReview) => next, null);
  useEffect(() => {
    if (!key) return;
    let current = true;
    void reviewRowsChunk().catch(() => undefined);
    void invoke<SubmissionReview | null>("submission_review").then(
      (review) => review,
      // A project the backend cannot read has nothing to report, not a failure to show.
      () => null,
    ).then((review) => {
      if (current) setRead({ key, review });
    });
    return () => { current = false; };
    // The tree and the build are only signals to read again.
  }, [key, tree, build]);
  return read?.key === key && key ? read.review : null;
}

export function reviewRows(review: SubmissionReview | null): ReviewRow[] {
  if (!review) return [];
  const row = (id: ReviewRow["id"], checks: ReviewFinding["check"][], settled = true): ReviewRow => {
    const findings = review.findings.filter((finding) => checks.includes(finding.check));
    return { id, ok: settled ? findings.length === 0 : null, findings };
  };
  const rows: ReviewRow[] = [];
  if (review.mode && review.mode !== "camera-ready") {
    rows.push(
      { ...row("authors", ["authors-shown"]), ok: review.mode === "anonymous" ? true : review.mode === "authors-shown" ? false : null },
      row("acknowledgements", ["acknowledgements", "thanks"]),
      row("links", ["identifying-link"]),
      row("self-citation", ["self-citation"]),
      row("pdf-author", ["pdf-author"], review.pdf),
    );
  }
  const fontsSettled = review.pdf && review.fontsRead;
  rows.push(row("type3", ["type3-font"], fontsSettled), row("unembedded", ["unembedded-font"], fontsSettled));
  return rows;
}
