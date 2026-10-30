import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";

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

type ReviewRow = {
  id: string;
  label: string;
  ok: boolean | null;
  value: string;
  detail?: string;
  findings: ReviewFinding[];
};

export type ReviewGroup = { id: string; title: string; note?: string; rows: ReviewRow[] };

type ReadReview = { key: string; review: SubmissionReview | null };

/**
 * The review of the open project, read while the checklist is open and again
 * whenever the project's tree (after a file event) or its last build changes.
 * Answers that arrive for another project, or after the checklist closed,
 * are dropped.
 */
export function useSubmissionReview(scope: string, wanted: boolean, tree: unknown, build: unknown): SubmissionReview | null {
  const key = wanted ? scope : "";
  const [read, setRead] = useReducer((_: ReadReview | null, next: ReadReview) => next, null);
  useEffect(() => {
    if (!key) return;
    let current = true;
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

/**
 * The review as checklist rows. The anonymity group follows the venue: only a
 * double-blind template has one, and a camera-ready copy keeps only a note,
 * since naming its authors is the point. Without a PDF (or a PDF whose fonts
 * cannot be read) the PDF rows cannot be settled.
 */
export function useReviewGroups(review: SubmissionReview | null): ReviewGroup[] {
  const { t } = useLingui();
  if (!review) return [];
  const of = (...checks: ReviewFinding["check"][]) => review.findings.filter((finding) => checks.includes(finding.check));
  const counted = (findings: ReviewFinding[], settled = true) => ({
    ok: settled ? findings.length === 0 : null,
    value: !settled ? t`Build to check` : findings.length ? `${findings.length}` : t`None`,
    findings,
  });
  const groups: ReviewGroup[] = [];
  const venue = review.venue ?? "";
  if (review.mode === "camera-ready") {
    groups.push({ id: "blind", title: t`Double-blind review`, note: t`${venue} camera-ready copy: anonymity is not checked.`, rows: [] });
  } else if (review.mode) {
    const shown = of("authors-shown");
    groups.push({
      id: "blind",
      title: t`Double-blind review · ${venue}`,
      rows: [
        {
          id: "authors",
          label: t`Author names`,
          ok: review.mode === "anonymous" ? true : review.mode === "authors-shown" ? false : null,
          value: review.mode === "anonymous" ? t`Hidden` : review.mode === "authors-shown" ? t`Shown` : t`Unknown`,
          detail: review.mode === "authors-shown"
            ? t`The template's option prints the authors; remove it for review`
            : review.mode === "unknown" ? t`The template's options were not found` : undefined,
          findings: shown,
        },
        { id: "acknowledgements", label: t`Acknowledgements and thanks`, ...counted(of("acknowledgements", "thanks")) },
        { id: "links", label: t`Links to your accounts`, ...counted(of("identifying-link")) },
        { id: "self-citation", label: t`Self-citing wording`, ...counted(of("self-citation")) },
        { id: "pdf-author", label: t`Author in PDF metadata`, ...counted(of("pdf-author"), review.pdf) },
      ],
    });
  }
  const fontsSettled = review.pdf && review.fontsRead;
  groups.push({
    id: "fonts",
    title: t`PDF fonts`,
    rows: [
      { id: "type3", label: t`Type 3 fonts`, ...counted(of("type3-font"), fontsSettled) },
      { id: "unembedded", label: t`Fonts not embedded`, ...counted(of("unembedded-font"), fontsSettled) },
    ],
  });
  return groups;
}
