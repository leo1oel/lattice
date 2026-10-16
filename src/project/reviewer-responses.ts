/**
 * The writer's answers to a venue's reviewers: each comment as the reviewer
 * wrote it under a number that never changes (R1.1, R2.3), with who owns it,
 * the reply, whether the reply has been checked, whether the paper still has
 * to change for it, and the annotations that mark where it did.
 *
 * "Changed" and "answered" are kept apart on purpose: a reply can be final
 * while the experiment it promises is still running, and a passage can be
 * rewritten before anyone has written the reply that points at it. The letter
 * this builds never claims a change that is not marked done, and opens with
 * what is still unanswered.
 *
 * Pure: the store (`app/reviewer-responses.ts`) keeps the state and the file,
 * the panel (`reviewer-responses-panel.tsx`) draws it.
 */
import { isRecord } from "../app-utils";

/** Whether the paper still has to change for a comment, has, or needs no change. */
const RESPONSE_CHANGES = ["todo", "done", "none"] as const;
export type ResponseChange = (typeof RESPONSE_CHANGES)[number];

export type ReviewerComment = {
  id: string;
  /** The reviewer's number (the 1 of R1.2). */
  reviewer: number;
  /** The comment's number for its reviewer (the 2 of R1.2), kept for its life. */
  number: number;
  /** The reviewer's words as they were pasted, never edited afterwards. */
  comment: string;
  /** Who answers it; free text. */
  owner: string;
  reply: string;
  /** Whether the reply has been read against the paper; editing the reply clears it. */
  replyChecked: boolean;
  change: ResponseChange;
  /**
   * The annotations (by id, as pin numbers are given again once the highest
   * is deleted) on the passages changed for it. One annotation can serve
   * several comments: the same new paragraph may answer two reviewers.
   */
  annotationIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ReviewerResponses = {
  version: 1;
  /** A reviewer's name as the venue gives it (OpenReview's "xK7p"), by reviewer number. */
  reviewers: Record<string, string>;
  /** The highest comment number each reviewer has had, so a removed comment's number is never given again. */
  last: Record<string, number>;
  comments: ReviewerComment[];
};

export const EMPTY_RESPONSES: ReviewerResponses = { version: 1, reviewers: {}, last: {}, comments: [] };

/**
 * Where a comment stands: `unanswered` has no reply, `drafted` has one not
 * yet checked, `changing` is answered but the paper still has to change, and
 * `done` is answered with nothing left to change.
 */
export type ResponseStatus = "unanswered" | "drafted" | "changing" | "done";

export function responseStatus(comment: Pick<ReviewerComment, "reply" | "replyChecked" | "change">): ResponseStatus {
  if (!comment.reply.trim()) return "unanswered";
  if (!comment.replyChecked) return "drafted";
  return comment.change === "todo" ? "changing" : "done";
}

export function commentLabel(comment: Pick<ReviewerComment, "reviewer" | "number">): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- the venue's own numbering, the same in every language
  return `R${comment.reviewer}.${comment.number}`;
}

/** Reviewer by reviewer, each in the order its comments were numbered. */
export function sortedComments(comments: readonly ReviewerComment[]): ReviewerComment[] {
  return [...comments].sort((a, b) => a.reviewer - b.reviewer || a.number - b.number);
}

/** The reviewers that have comments, in order. */
export function reviewerNumbers(state: ReviewerResponses): number[] {
  return [...new Set(state.comments.map((comment) => comment.reviewer))].sort((a, b) => a - b);
}

/** The number a reviewer new to the project takes. */
export function nextReviewer(state: ReviewerResponses): number {
  const known = [
    ...state.comments.map((comment) => comment.reviewer),
    ...Object.keys(state.last).map(Number),
    ...Object.keys(state.reviewers).map(Number),
  ].filter(Number.isFinite);
  return known.reduce((highest, number) => Math.max(highest, number), 0) + 1;
}

/** A reviewer already in the project by the name the venue gave them. */
export function reviewerNamed(state: ReviewerResponses, name: string): number | null {
  const wanted = name.trim().toLowerCase();
  const found = Object.entries(state.reviewers).find(([, known]) => known.toLowerCase() === wanted);
  return found ? Number(found[0]) : null;
}

/** The number a reviewer's next comment takes. */
export function nextCommentNumber(state: ReviewerResponses, reviewer: number): number {
  return Math.max(
    state.last[String(reviewer)] ?? 0,
    ...state.comments.filter((comment) => comment.reviewer === reviewer).map((comment) => comment.number),
  ) + 1;
}

/** Comments to add, for one reviewer. */
export type NewReviewerComments = { reviewer: number; name?: string; comments: string[] };

/** Add comments under their reviewers' next numbers. */
export function addComments(
  state: ReviewerResponses,
  groups: readonly NewReviewerComments[],
  now = new Date().toISOString(),
): ReviewerResponses {
  const last = { ...state.last };
  const reviewers = { ...state.reviewers };
  const added: ReviewerComment[] = [];
  for (const group of groups) {
    const key = String(group.reviewer);
    if (group.name?.trim() && !reviewers[key]) reviewers[key] = group.name.trim();
    let number = Math.max(last[key] ?? 0, nextCommentNumber(state, group.reviewer) - 1);
    for (const text of group.comments) {
      const comment = text.trim();
      if (!comment) continue;
      number += 1;
      added.push({
        id: crypto.randomUUID(),
        reviewer: group.reviewer,
        number,
        comment,
        owner: "",
        reply: "",
        replyChecked: false,
        change: "todo",
        annotationIds: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    if (number) last[key] = number;
  }
  return { ...state, reviewers, last, comments: [...state.comments, ...added] };
}

/** The writable parts of a comment; its words and number are not among them. */
export type ReviewerCommentChange = Partial<Pick<ReviewerComment, "owner" | "reply" | "replyChecked" | "change" | "annotationIds">>;

/** Change one comment. A reply edited after it was checked has to be checked again. */
export function updateComment(
  state: ReviewerResponses,
  id: string,
  change: ReviewerCommentChange,
  now = new Date().toISOString(),
): ReviewerResponses {
  return {
    ...state,
    comments: state.comments.map((comment) => {
      if (comment.id !== id) return comment;
      const next = { ...comment, ...change, updatedAt: now };
      if (change.reply !== undefined && change.reply !== comment.reply && change.replyChecked === undefined) {
        next.replyChecked = false;
      }
      if (!next.reply.trim()) next.replyChecked = false;
      return next;
    }),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, number]) => {
    const valid = positive(number);
    return positive(Number(key)) && valid ? [[key, valid]] : [];
  }));
}

/**
 * The stored responses, or null when the file is not one this version reads.
 * A comment missing its words or number is left out rather than renumbered.
 */
export function parseResponses(value: unknown): ReviewerResponses | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.comments)) return null;
  const reviewers = isRecord(value.reviewers)
    ? Object.fromEntries(Object.entries(value.reviewers).filter(
      (entry): entry is [string, string] => positive(Number(entry[0])) !== null && typeof entry[1] === "string" && !!entry[1].trim(),
    ))
    : {};
  const seen = new Set<string>();
  const comments = value.comments.flatMap((item): ReviewerComment[] => {
    if (!isRecord(item)) return [];
    const reviewer = positive(item.reviewer);
    const number = positive(item.number);
    const id = text(item.id);
    const comment = text(item.comment);
    if (!reviewer || !number || !id || !comment.trim() || seen.has(id)) return [];
    seen.add(id);
    const change = RESPONSE_CHANGES.find((known) => known === item.change) ?? "todo";
    const reply = text(item.reply);
    return [{
      id,
      reviewer,
      number,
      comment,
      owner: text(item.owner),
      reply,
      replyChecked: item.replyChecked === true && !!reply.trim(),
      change,
      annotationIds: Array.isArray(item.annotationIds)
        ? [...new Set(item.annotationIds.flatMap((annotationId) => text(annotationId) || []))]
        : [],
      createdAt: text(item.createdAt),
      updatedAt: text(item.updatedAt),
    }];
  });
  return { version: 1, reviewers, last: numberRecord(value.last), comments };
}

/* ── Splitting pasted reviews ─────────────────────────────────────────── */

/** One piece of pasted text the split proposes as a comment, by its place in the text. */
export type PastedPart = {
  start: number;
  end: number;
  /** Proposed as left out: a heading alone, or a section that asks for nothing (Summary, Strengths, Rating). */
  skip: boolean;
};

/**
 * One reviewer's part of a paste: by the number its heading gave ("Reviewer
 * 2"), by the name it gave (OpenReview's "Reviewer xK7p"), or by neither when
 * the text has no heading, and the writer says whose it is.
 */
export type PastedReviewer = { number: number | null; name: string | null; parts: PastedPart[] };

const OPTIONAL_DECORATION = String.raw`[\s*_#>]*`;
/** "Reviewer 2", "**Reviewer #1 (score 6)**", "## R3:", "审稿人 1", "Referee 2". */
const NUMBERED_REVIEWER = new RegExp(
  String.raw`^${OPTIONAL_DECORATION}(?:(?:reviewer|referee|review)\s*#?\s*(\d{1,2})|R\s?(\d{1,2})|(?:审稿人|评审人|审稿专家|评审专家)\s*#?\s*(\d{1,2}))`
  + String.raw`[\s*_]*(?:[(（][^)）\n]*[)）])?[\s*_]*[:：.]?[\s*_]*$`,
  "i",
);
/** OpenReview's "Official Review of Submission1234 by Reviewer xK7p", or "Reviewer xK7p" alone. */
const NAMED_REVIEWER = new RegExp(
  String.raw`^${OPTIONAL_DECORATION}(?:official review of .{0,80}? by\s+)?reviewer\s+([A-Za-z0-9]{4})[\s*_]*[:：.]?[\s*_]*$`,
  "i",
);
/** "1." "2)" "(3)" "4、" "W1:" "Q2." "Comment 3:" "问题1：" at a line's start. */
const NUMBERED_ITEM = /^(\s*)(?:[-*•]\s+)?(?:\(\d{1,3}\)|\d{1,3}(?:[.)](?=\s)|[）、])|(?:Q|W|C|Comment|Weakness|Question|Concern|Point|Issue|Major|Minor|问题|意见)\s*#?\s*\d{1,3}(?:\s*[.:：)）]|\s))/i;
const BULLET_ITEM = /^(\s*)[-*•▪◦]\s+\S/;
/** A line that only names what follows: "Weaknesses:", "## Questions", "**Minor issues**". */
const SECTION_HEADING = /^\s*(?:#{1,6}\s+.{1,60}|[*_]{2}[^*_\n]{1,60}[*_]{2}[:：]?|[^\n.!?。！？]{1,40}[:：])\s*$/;
/** Sections that report rather than ask, proposed as left out. */
const NOT_A_REQUEST = /^[\s*_#]*(?:summary|strengths?|soundness|presentation|contribution|rating|overall|confidence|recommendation|flag for ethics|ethics|code of conduct|limitations? and societal impact|摘要|总结|优点|评分|置信度|推荐)\b/i;
/** A form field the review reports rather than asks with: "Rating: 6", "Confidence: 4". */
const REPORT_FIELD = new RegExp(String.raw`${NOT_A_REQUEST.source}\s*[:：]`, "i");

type Line = { start: number; end: number; text: string };

function linesOf(text: string, start: number, end: number): Line[] {
  const lines: Line[] = [];
  let at = start;
  while (at < end) {
    const newline = text.indexOf("\n", at);
    const stop = newline < 0 || newline >= end ? end : newline;
    lines.push({ start: at, end: stop, text: text.slice(at, stop) });
    at = stop + 1;
  }
  return lines;
}

/** The pasted text as the split reads it: one kind of line break, no trailing spaces before one. */
export function normalizePasted(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n");
}

function indent(line: string): number {
  return line.length - line.trimStart().length;
}

/** The lines where a new comment starts, by the markers they begin with. */
function itemStarts(lines: readonly Line[], marker: RegExp): Set<number> {
  const marked = lines.flatMap((line, index) => (marker.test(line.text) ? [index] : []));
  if (marked.length < 2) return new Set();
  // Only the outermost list: a sub-point (indented "a)", "-") stays with its comment.
  const outer = Math.min(...marked.map((index) => indent(lines[index].text)));
  return new Set(marked.filter((index) => indent(lines[index].text) === outer));
}

/** One reviewer's text, cut into the comments it seems to hold. */
function splitBlock(text: string, start: number, end: number): PastedPart[] {
  const lines = linesOf(text, start, end);
  let starts = itemStarts(lines, NUMBERED_ITEM);
  if (!starts.size) starts = itemStarts(lines, BULLET_ITEM);
  const boundaries = new Set<number>();
  if (starts.size) {
    for (const index of starts) boundaries.add(index);
    // A section heading between lists ("Questions:") starts a part of its own,
    // so it is not read as the end of the comment above it.
    lines.forEach((line, index) => {
      if (!starts.has(index) && (SECTION_HEADING.test(line.text) || REPORT_FIELD.test(line.text))) boundaries.add(index);
    });
  } else {
    // No list: a comment per paragraph, and a heading starts one.
    lines.forEach((line, index) => {
      const previous = lines[index - 1];
      if (!line.text.trim()) return;
      if (!previous || !previous.text.trim() || SECTION_HEADING.test(line.text) || REPORT_FIELD.test(line.text)) boundaries.add(index);
    });
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  if (!ordered.length || ordered[0] !== 0) ordered.unshift(0);
  const parts: PastedPart[] = [];
  let section = "";
  ordered.forEach((first, at) => {
    const last = (ordered[at + 1] ?? lines.length) - 1;
    const body = lines.slice(first, last + 1);
    const content = body.filter((line) => line.text.trim());
    if (!content.length) return;
    const from = content[0].start + indent(content[0].text);
    const to = content[content.length - 1].end;
    const opensWithHeading = SECTION_HEADING.test(content[0].text) && !starts.has(first);
    // A list item stays in the section above it; a heading or a paragraph starts one.
    if (opensWithHeading || !starts.has(first)) section = content[0].text;
    const headingOnly = opensWithHeading && content.length === 1;
    parts.push({ start: from, end: to, skip: headingOnly || NOT_A_REQUEST.test(section) });
  });
  return parts;
}

/**
 * Cut a paste of reviews into reviewers and comments to propose: at reviewer
 * headings, then at the outermost numbered (or else bulleted) list, or else
 * at paragraphs. Offsets are into `normalizePasted(text)`, which callers
 * pass here; the writer confirms or joins the parts before anything is added.
 */
export function splitPastedReviews(text: string): PastedReviewer[] {
  const lines = linesOf(text, 0, text.length);
  const blocks: Array<{ number: number | null; name: string | null; start: number; end: number }> = [];
  let current: { number: number | null; name: string | null; start: number } = { number: null, name: null, start: 0 };
  for (const line of lines) {
    const numbered = NUMBERED_REVIEWER.exec(line.text);
    const named = numbered ? null : NAMED_REVIEWER.exec(line.text);
    if (!numbered && !named) continue;
    blocks.push({ ...current, end: line.start });
    current = numbered
      ? { number: Number(numbered[1] ?? numbered[2] ?? numbered[3]), name: null, start: line.end }
      : { number: null, name: named![1], start: line.end };
  }
  blocks.push({ ...current, end: text.length });
  const reviewers: PastedReviewer[] = [];
  for (const block of blocks) {
    const parts = splitBlock(text, block.start, block.end);
    if (!parts.length && block.number == null && block.name == null) continue;
    // A reviewer named twice in one paste ("Reviewer 1" … "Reviewer 1, continued") is one reviewer.
    const same = reviewers.find((reviewer) => (block.number != null && reviewer.number === block.number)
      || (block.name != null && reviewer.name?.toLowerCase() === block.name.toLowerCase()));
    if (same) same.parts.push(...parts);
    else reviewers.push({ number: block.number, name: block.name, parts });
  }
  return reviewers.filter((reviewer) => reviewer.parts.length);
}

/**
 * Which reviewer each pasted reviewer is: the number its heading gave, the
 * reviewer already known by its name, or a new number in the order the paste
 * names them; a paste without a heading is `unheaded`'s, the writer's choice.
 */
export function pastedReviewerNumbers(
  state: ReviewerResponses,
  pasted: readonly PastedReviewer[],
  unheaded: number,
): number[] {
  const taken = new Set([
    ...reviewerNumbers(state),
    ...Object.keys(state.last).map(Number),
    ...Object.keys(state.reviewers).map(Number),
    ...pasted.flatMap((reviewer) => reviewer.number ?? []),
    ...pasted.some((reviewer) => reviewer.number == null && reviewer.name == null) ? [unheaded] : [],
  ]);
  // A new name takes the lowest number no one has: "Reviewer xK7p" above a
  // "Reviewer 2" is R1, not R3.
  const free = () => {
    let number = 1;
    while (taken.has(number)) number += 1;
    taken.add(number);
    return number;
  };
  const named = new Map<string, number>();
  return pasted.map((reviewer) => {
    if (reviewer.number != null) return reviewer.number;
    if (reviewer.name == null) return unheaded;
    const key = reviewer.name.toLowerCase();
    const known = reviewerNamed(state, reviewer.name) ?? named.get(key);
    if (known != null) return known;
    const number = free();
    named.set(key, number);
    return number;
  });
}

/**
 * The comments a reviewer's parts make once the writer has decided: a part
 * in `joined` continues the one before it, and a part in `skipped` (or a
 * group whose first part is) is left out. Keys are parts' `start` offsets.
 */
export function assembleParts(
  text: string,
  parts: readonly PastedPart[],
  joined: ReadonlySet<number>,
  skipped: ReadonlySet<number>,
): string[] {
  const groups: PastedPart[][] = [];
  for (const part of parts) {
    const previous = groups.at(-1);
    if (previous && joined.has(part.start)) previous.push(part);
    else groups.push([part]);
  }
  return groups
    .filter((group) => !skipped.has(group[0].start))
    .map((group) => text.slice(group[0].start, group[group.length - 1].end).trim())
    .filter(Boolean);
}

/** Whether a part is proposed as left out until the writer says otherwise. */
export function initiallySkipped(reviewers: readonly PastedReviewer[]): Set<number> {
  return new Set(reviewers.flatMap((reviewer) => reviewer.parts.filter((part) => part.skip).map((part) => part.start)));
}

/* ── The response letter ──────────────────────────────────────────────── */

/**
 * Where a linked annotation's passage is now: `placed` at a line, `moved`
 * when its quoted text is no longer in its file (rewritten, or the file
 * gone), `missing` when the annotation itself was deleted.
 */
export type LinkPlace =
  | { state: "placed"; path: string; line: number; quote: string }
  | { state: "moved"; path: string; quote: string }
  | { state: "missing" };

export type LetterFormat = "markdown" | "latex";

/** The labels of the comments in `status`, in letter order. */
function labelsWhere(comments: readonly ReviewerComment[], keep: (comment: ReviewerComment) => boolean): string[] {
  return comments.filter(keep).map(commentLabel);
}

function shortQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

const LATEX_SPECIALS: Record<string, string> = {
  "\\": String.raw`\textbackslash{}`,
  "{": String.raw`\{`,
  "}": String.raw`\}`,
  "#": String.raw`\#`,
  "$": String.raw`\$`,
  "%": String.raw`\%`,
  "&": String.raw`\&`,
  "_": String.raw`\_`,
  "^": String.raw`\^{}`,
  "~": String.raw`\textasciitilde{}`,
};

/** Text as LaTeX prints it, not as LaTeX reads it: a reviewer's `50%` is not a comment. */
export function escapeLatex(text: string): string {
  return text.replace(/[\\{}#$%&_^~]/g, (character) => LATEX_SPECIALS[character]);
}

/**
 * The response letter, reviewer by reviewer in numbered order: each comment
 * quoted as the reviewer wrote it, the reply, and where the paper changed.
 * It opens with what is not yet answered, checked or changed, and claims a
 * change only for a comment marked changed; a reply is the writer's own text
 * and goes in as written (in LaTeX, as LaTeX). The scaffolding is English,
 * the language of nearly every venue's letter.
 */
export function responseLetter(
  state: ReviewerResponses,
  format: LetterFormat,
  placeOf: (annotationId: string) => LinkPlace,
): string {
  /* eslint-disable lingui/no-unlocalized-strings -- the letter goes to the venue, in English */
  const comments = sortedComments(state.comments);
  const latex = format === "latex";
  const unanswered = labelsWhere(comments, (comment) => responseStatus(comment) === "unanswered");
  const unchecked = labelsWhere(comments, (comment) => responseStatus(comment) === "drafted");
  const toChange = labelsWhere(comments, (comment) => comment.change === "todo");
  const notes = [
    unanswered.length ? ["Not yet answered", unanswered] as const : null,
    unchecked.length ? ["Replies not yet checked", unchecked] as const : null,
    toChange.length ? ["Changes still to make", toChange] as const : null,
  ].filter((note) => note !== null);
  const out: string[] = [];
  if (latex) {
    out.push("% Response to the reviewers, written by Lattice. \\input it into your letter.", "");
    for (const [title, labels] of notes) out.push(`\\noindent\\textbf{${title}:} ${labels.join(", ")}.\\par`);
    if (notes.length) out.push("");
  } else {
    out.push("# Response to the reviewers", "");
    for (const [title, labels] of notes) out.push(`> **${title}:** ${labels.join(", ")}`);
    if (notes.length) out.push("");
  }
  const where = (comment: ReviewerComment): string[] => comment.annotationIds.map((annotationId) => {
    const place = placeOf(annotationId);
    if (place.state === "missing") return "Annotation deleted";
    const file = latex ? `\\texttt{${escapeLatex(place.path)}}` : `\`${place.path}\``;
    const quote = latex ? `\`\`${escapeLatex(shortQuote(place.quote))}''` : `“${shortQuote(place.quote)}”`;
    return place.state === "placed" ? `${file}, line ${place.line}: ${quote}` : `${file} (passage since rewritten): ${quote}`;
  });
  for (const reviewer of reviewerNumbers(state)) {
    const name = state.reviewers[String(reviewer)];
    const heading = name ? `Reviewer ${reviewer} (${name})` : `Reviewer ${reviewer}`;
    out.push(latex ? `\\section*{Response to ${escapeLatex(heading)}}` : `## ${heading}`, "");
    for (const comment of comments.filter((item) => item.reviewer === reviewer)) {
      const label = commentLabel(comment);
      if (latex) {
        out.push(`\\subsection*{${label}}`, "\\begin{quote}\\itshape");
        out.push(escapeLatex(comment.comment.trim()));
        out.push("\\end{quote}", "");
        out.push(`\\noindent\\textbf{Response.} ${comment.reply.trim() || "\\emph{No response yet.}"}`, "");
      } else {
        out.push(`### ${label}`, "");
        out.push(...comment.comment.trim().split("\n").map((line) => (line ? `> ${line}` : ">")), "");
        out.push(`**Response.** ${comment.reply.trim() || "_No response yet._"}`, "");
      }
      const places = where(comment);
      if (comment.change === "done" && places.length) {
        out.push(latex ? `\\noindent\\textbf{Changes.} ${places.join("; ")}.` : `**Changes.** ${places.join("; ")}.`, "");
      } else if (comment.change === "todo") {
        out.push(latex ? "\\noindent\\textbf{Changes.} \\emph{Still to make.}" : "**Changes.** _Still to make._", "");
      }
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
  /* eslint-enable lingui/no-unlocalized-strings */
}
