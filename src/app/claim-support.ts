import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import type { ClaimCitationOutcome, OpenProjectFile, PaperSummary } from "../app-types";
import { toMessage } from "../app-utils";
import { ProofreadFailure } from "../agent/agent-proofread";
import {
  claimContext,
  judgeSupportWithAgent,
  plainClaim,
  supportTermsWithAgent,
  type SupportCandidate,
} from "../agent/agent-support";
import { resolveCommentAnchor } from "../editor/comments/editor-comment-data";
import { baseArxivId } from "../papers/arxiv-id";
import type { LiteratureHit } from "../papers/literature-discovery-panel";
import { i18n } from "../i18n";
import { notifyInfo } from "../telemetry/app-notify";
import { annotationRounds } from "./annotation-rounds";

type Ref<T> = { readonly current: T };

/**
 * The claim a search is for, pinned to the source as an annotation is:
 * `quote` is the source's text at `[from, to)` of `path` when it was asked,
 * with the words around it so it can be found again once the paper changes.
 */
export type SupportClaim = {
  path: string;
  line: number;
  from: number;
  to: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** Search keywords already chosen for it (the paper review names some). */
  terms?: string;
};

/** What finding support reads and does in the app, attached by App once it has them. */
export type ClaimSupportDeps = {
  projectRootRef: Ref<string | null>;
  openPanel: () => void;
  openProjectFile: OpenProjectFile;
  /** The project's papers, to say which candidates are already in it. */
  library: () => readonly PaperSummary[];
  /** Add a bibliography entry for `query` (a DOI, arXiv id or title) and answer its key; null when nothing was added. */
  addCitation: (query: string) => Promise<string | null>;
  /** Import `query` into Papers with its full text; answers its key, or null when nothing was imported. */
  addToPapers: (query: string) => Promise<string | null>;
  /** Put `\citep{key}` after the claim in the editor. */
  citeAfter: (claim: SupportClaim, key: string) => Promise<ClaimCitationOutcome>;
  /** Open Discover literature on `query`, for a search the writer runs themselves. */
  searchLiterature: (query: string) => void;
};

/** A candidate as the panel shows it, with what the writer has done with it. */
export type SupportPaper = SupportCandidate & {
  /** Its citation key once it is in the bibliography, from the library or a Cite. */
  key?: string;
  /** Whether it is in Papers already, or was added from here. */
  inPapers: boolean;
  cited?: boolean;
  dismissed?: boolean;
};

/** A search in flight: "terms" while the agent picks keywords, "searching" OpenAlex, "reading" abstracts. */
export type ClaimSupportRun = { stage: "terms" | "searching" | "reading"; terms: string | null; found: number };

export type ClaimSupportResult = {
  /** Which search this is, so an Undo from an earlier one does nothing. */
  search: number;
  terms: string;
  /** How many abstracts the agent read. */
  read: number;
  papers: SupportPaper[];
};

/** What React reads, a new object on every change. */
export type ClaimSupportSnapshot = {
  claim: (SupportClaim & { text: string }) | null;
  run: ClaimSupportRun | null;
  result: ClaimSupportResult | null;
  error: string | null;
  /** Papers being cited or added, which take no other action meanwhile. */
  busy: ReadonlyMap<string, "cite" | "add">;
};

const EMPTY: ClaimSupportSnapshot = { claim: null, run: null, result: null, error: null, busy: new Map() };

/** How long a citation waits for the editor to show the claim's file. */
const CITE_WAIT_MS = 10_000;

const normalTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The library paper that is `candidate`: same DOI, same arXiv paper, or the same title. */
export function libraryMatch(candidate: SupportCandidate, papers: readonly PaperSummary[]): PaperSummary | null {
  const doi = candidate.doi?.toLowerCase();
  const arxiv = candidate.arxivId ? baseArxivId(candidate.arxivId).toLowerCase() : null;
  const title = normalTitle(candidate.title);
  return papers.find((paper) => (doi && paper.doi?.toLowerCase() === doi)
    || (arxiv && paper.arxivId && baseArxivId(paper.arxivId).toLowerCase() === arxiv)
    || (title.length > 12 && normalTitle(paper.title) === title)) ?? null;
}

/** What a citation or import is asked with: the DOI, else the arXiv id, else the title. */
function lookup(paper: SupportCandidate): string {
  return paper.doi ?? (paper.arxivId ? `arXiv:${paper.arxivId}` : paper.title);
}

function failureMessage(reason: unknown): string {
  if (reason instanceof ProofreadFailure) {
    if (reason.kind === "unavailable") {
      return i18n._(msg`This version of the agent runtime cannot find support yet. Update Lattice to use it.`);
    }
    if (reason.kind === "unreadable") return i18n._(msg`The agent's answer could not be read. Try again.`);
    return reason.detail
      ? i18n._(msg`The agent could not read the papers: ${reason.detail}`)
      : i18n._(msg`The agent could not read the papers.`);
  }
  return toMessage(reason);
}

const timeout = (ms: number) => new Promise<"moved">((resolve) => window.setTimeout(() => resolve("moved"), ms));

/**
 * Finding support for a claim: the writer selects a sentence (or a review
 * point names one), and the agent reads what OpenAlex finds for it and
 * names the papers whose abstract speaks to it, each with the sentence that
 * does. Cite adds the paper to the bibliography and puts `\citep{key}`
 * after the claim; Add to Papers imports it with its full text.
 *
 * One search at a time, for the claim on screen; a new claim replaces it.
 * Nothing is kept on disk: a claim's support is asked for when it is wanted.
 * A plain object rather than a hook (one per window, `claimSupport` below),
 * like the paper review: only the panel subscribes.
 */
export class ClaimSupport {
  private deps: ClaimSupportDeps | null = null;
  private snapshot: ClaimSupportSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  /** Bumped by `reset` and by each new search, so work for an earlier one drops its results. */
  private generation = 0;

  attach(deps: ClaimSupportDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private publish(change: Partial<ClaimSupportSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  /** Find support for `claim`, replacing the search on screen, and show the panel. */
  find = async (claim: SupportClaim) => {
    const deps = this.deps;
    const projectRoot = deps?.projectRootRef.current;
    if (!deps || !projectRoot) return;
    const text = plainClaim(claim.quote);
    if (!text) return;
    this.controller?.abort();
    this.generation += 1;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const live = () => generation === this.generation;
    this.publish({
      claim: { ...claim, text },
      result: null,
      error: null,
      busy: new Map(),
      run: { stage: claim.terms ? "searching" : "terms", terms: claim.terms ?? null, found: 0 },
    });
    deps.openPanel();
    try {
      const source = await annotationRounds.readSource(claim.path);
      const range = source == null ? null : resolveCommentAnchor(source, claim);
      const context = source != null && range ? claimContext(source, range.from, range.to) : text;
      if (!live()) return;
      const terms = claim.terms
        ?? await supportTermsWithAgent({ projectRoot, claim: text, context, signal: controller.signal });
      if (!live()) return;
      this.publish({ run: { stage: "searching", terms, found: 0 } });
      const hits = await invoke<LiteratureHit[]>("search_literature_abstracts", { query: terms });
      if (!live()) return;
      this.publish({ run: { stage: "reading", terms, found: hits.length } });
      const judged = await judgeSupportWithAgent({ projectRoot, claim: text, context, hits, signal: controller.signal });
      if (!live()) return;
      const library = deps.library();
      const papers = judged.candidates.map((candidate): SupportPaper => {
        const match = libraryMatch(candidate, library);
        return { ...candidate, ...match?.citationKey ? { key: match.citationKey } : {}, inPapers: Boolean(match) };
      });
      this.controller = null;
      this.publish({ run: null, result: { search: generation, terms, read: judged.read, papers } });
    } catch (reason) {
      if (!live()) return;
      this.controller = null;
      this.publish({ run: null, error: controller.signal.aborted ? null : failureMessage(reason) });
    }
  };

  /** Search again for the claim on screen. */
  retry = () => {
    const claim = this.snapshot.claim;
    if (!claim) return;
    const { text: _text, ...rest } = claim;
    void this.find({ ...rest, terms: claim.terms ?? this.snapshot.result?.terms });
  };

  /** Stop the search in flight. */
  cancel = () => {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.publish({ run: null });
  };

  /** Stop and forget everything: the project is closing or changing. */
  reset = () => {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.snapshot = EMPTY;
    for (const listener of [...this.listeners]) listener();
  };

  /** Show the claim where it is now. */
  reveal = async () => {
    const claim = this.snapshot.claim;
    const deps = this.deps;
    if (!claim || !deps) return;
    const source = await annotationRounds.readSource(claim.path);
    const range = source == null ? null : resolveCommentAnchor(source, claim);
    const line = source != null && range ? source.slice(0, range.from).split("\n").length : claim.line;
    await deps.openProjectFile(claim.path, { line });
  };

  private paper(id: string) {
    return this.snapshot.result?.papers.find((paper) => paper.id === id) ?? null;
  }

  private update(id: string, change: Partial<SupportPaper>) {
    const result = this.snapshot.result;
    if (!result) return;
    this.publish({ result: { ...result, papers: result.papers.map((paper) => (paper.id === id ? { ...paper, ...change } : paper)) } });
  }

  private setBusy(id: string, action: "cite" | "add" | null) {
    const busy = new Map(this.snapshot.busy);
    if (action) busy.set(id, action);
    else busy.delete(id);
    this.publish({ busy });
  }

  /** Run `work` for paper `id` while it is busy, dropping its outcome once the search on screen changed. */
  private async act(id: string, action: "cite" | "add", work: (paper: SupportPaper, live: () => boolean) => Promise<void>) {
    const paper = this.paper(id);
    if (!paper || !this.deps || this.snapshot.busy.has(id)) return;
    const generation = this.generation;
    const live = () => generation === this.generation;
    this.setBusy(id, action);
    try {
      await work(paper, live);
    } catch (reason) {
      if (live()) notifyInfo(i18n._(msg`Find support`), toMessage(reason), { dedupeKey: `claim-support-${action}:${id}` });
    } finally {
      if (live()) this.setBusy(id, null);
    }
  }

  /** Add the paper to the bibliography when it is not there, and cite it after the claim. */
  cite = (id: string) => this.act(id, "cite", async (paper, live) => {
    const deps = this.deps!;
    const claim = this.snapshot.claim;
    if (!claim) return;
    const key = paper.key ?? await deps.addCitation(lookup(paper));
    if (!key || !live()) return;
    this.update(id, { key });
    const outcome = await Promise.race([deps.citeAfter(claim, key), timeout(CITE_WAIT_MS)]);
    if (!live()) return;
    if (outcome === "cited" || outcome === "already") {
      this.update(id, { cited: true });
      return;
    }
    const command = `\\citep{${key}}`;
    notifyInfo(i18n._(msg`Find support`), outcome === "read-only"
      ? i18n._(msg`This file can't be edited here, so the claim was not cited. The paper is in the bibliography as ${command}.`)
      : i18n._(msg`The claim has changed since the search, so the citation has nowhere to go. The paper is in the bibliography as ${command}.`), {
      dedupeKey: `claim-support-cite:${id}`,
    });
  });

  /** Import the paper into Papers, with its full text when it can be had. */
  add = (id: string) => this.act(id, "add", async (paper, live) => {
    const query = paper.arxivId ? `arXiv:${paper.arxivId}` : lookup(paper);
    const key = await this.deps!.addToPapers(query);
    if (!key || !live()) return;
    this.update(id, { key, inPapers: true });
  });

  /** Set a paper aside, with the toast's Undo to bring it back. */
  dismiss = (id: string) => {
    const result = this.snapshot.result;
    if (!this.paper(id) || !result || this.snapshot.busy.has(id)) return;
    this.update(id, { dismissed: true });
    notifyInfo(i18n._(msg`Find support`), i18n._(msg`Paper set aside`), {
      dedupeKey: `claim-support-dismissed:${id}`,
      primaryAction: {
        label: i18n._(msg`Undo`),
        onClick: () => {
          if (this.snapshot.result?.search === result.search) this.update(id, { dismissed: false });
        },
      },
    });
  };

  /** Hand the search to Discover literature, to look further than the first page. */
  searchFurther = () => {
    const terms = this.snapshot.result?.terms ?? this.snapshot.run?.terms;
    if (terms) this.deps?.searchLiterature(terms);
  };
}

/** The window's claim support, for its one project at a time. */
export const claimSupport = new ClaimSupport();
