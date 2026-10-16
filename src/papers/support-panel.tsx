/**
 * Support for a claim (`app/claim-support.ts`), as a tool panel. The claim
 * stays quoted at the top, where it is in the source a click away (Grammarly
 * keeps the sentence highlighted, Perplexity heads its answer with it). Each
 * paper is a card with a named signal rather than a percentage (Elicit's
 * Yes / Maybe / No), its byline, and the exact sentence of its abstract that
 * speaks to the claim, never a paraphrase; the sentence opens onto the whole
 * abstract with it marked in place (Elicit tints the passage in context).
 * Cite is the one main action: it adds the bibliography entry and puts
 * `\citep{key}` after the claim.
 */
import { useState, useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { BookSearch, Check, ExternalLink, Library, Quote, RotateCw, Search, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { InfinityLoader } from "../components/ui/activity-icons";
import { EmptyState } from "../components/ui/empty-state";
import { IconButton } from "../components/ui/icon-button";
import { InlineMessage } from "../components/ui/inline-message";
import { PanelHeader } from "../components/ui/panel-header";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { SUPPORT_MAX_PAPERS, type SupportSignal } from "../agent/agent-support";
import {
  claimSupport, type ClaimSupportResult, type ClaimSupportRun, type ClaimSupportSnapshot, type SupportPaper,
} from "../app/claim-support";
import { formatCount } from "../i18n";
import "./support-panel.css";

function Claim({ claim }: { claim: NonNullable<ClaimSupportSnapshot["claim"]> }) {
  const { t } = useLingui();
  const place = `${claim.path}:${claim.line}`;
  return (
    <figure className="support-claim">
      <figcaption>
        <button type="button" onClick={() => void claimSupport.reveal()} title={t`Show in the source`}>
          {t`Your claim · ${place}`}
        </button>
      </figcaption>
      <blockquote>{claim.text}</blockquote>
    </figure>
  );
}

function Searching({ run }: { run: ClaimSupportRun }) {
  const { t, i18n } = useLingui();
  const terms = run.terms ?? "";
  const count = Math.min(run.found, SUPPORT_MAX_PAPERS);
  const line = run.stage === "terms"
    ? t`Working out what to search for…`
    : run.stage === "searching"
      ? t`Searching OpenAlex for “${terms}”…`
      : count === 1 ? t`Reading 1 abstract for this claim…` : t`Reading ${formatCount(count, i18n.locale)} abstracts for this claim…`;
  return (
    <div className="support-searching" role="status">
      <span className="support-pulse" aria-hidden="true" />
      <p>{line}</p>
      {run.stage === "reading" ? <p className="support-searching-detail">{t`Searched for “${terms}”`}</p> : null}
      <Button size="compact" variant="ghost" onClick={claimSupport.cancel}>{t`Stop`}</Button>
    </div>
  );
}

/** The paper's authors as a byline: the first three, then "et al.". */
function byline(authors: readonly string[], etAl: string): string {
  return authors.slice(0, 3).join(", ") + (authors.length > 3 ? etAl : "");
}

function Card({ paper, busy }: { paper: SupportPaper; busy: "cite" | "add" | undefined }) {
  const { t } = useLingui();
  const [whole, setWhole] = useState(false);
  const signals: Record<SupportSignal, string> = {
    supports: t`Supports`, mixed: t`Argues both ways`, contradicts: t`Contradicts`,
  };
  const { from, to } = paper.passage;
  const passage = paper.abstract.slice(from, to);
  // The year first: a long venue name gives way at the end, never the year.
  const published = [paper.year ? String(paper.year) : null, paper.venue].filter(Boolean).join(" · ");
  const command = paper.key ? `\\citep{${paper.key}}` : "";
  return (
    <li className="support-card" data-signal={paper.signal}>
      <div className="support-card-head">
        <span className="support-signal">{signals[paper.signal]}</span>
        {published ? <span className="support-venue" title={published}>{published}</span> : null}
      </div>
      <strong className="support-title">{paper.title}</strong>
      {paper.authors.length ? <span className="support-authors">{byline(paper.authors, t` et al.`)}</span> : null}
      <button
        type="button"
        className="support-passage"
        aria-expanded={whole}
        title={whole ? t`Show only the passage` : t`Show the whole abstract`}
        onClick={() => setWhole(!whole)}
      >
        <Quote size={12} aria-hidden="true" />
        <span>
          {whole ? paper.abstract.slice(0, from) : null}
          <mark>{passage}</mark>
          {whole ? paper.abstract.slice(to) : null}
        </span>
      </button>
      <div className="support-actions">
        {paper.cited ? (
          <span className="support-done support-cited"><Check size={14} aria-hidden="true" />{t`Cited · ${command}`}</span>
        ) : (
          <Button size="compact" variant="tinted" disabled={Boolean(busy)} onClick={() => void claimSupport.cite(paper.id)}>
            {busy === "cite" ? <InfinityLoader size={12} /> : <Quote size={12} aria-hidden="true" />}{t`Cite`}
          </Button>
        )}
        {paper.inPapers ? (
          <span className="support-done"><Check size={14} aria-hidden="true" />{t`In Papers`}</span>
        ) : (
          <Button size="compact" variant="ghost" disabled={Boolean(busy)} onClick={() => void claimSupport.add(paper.id)}>
            {busy === "add" ? <InfinityLoader size={12} /> : <Library size={14} aria-hidden="true" />}{t`Add to Papers`}
          </Button>
        )}
        {paper.page ? (
          <a
            className={buttonClassName({ variant: "ghost", size: "compact", className: "support-open" })}
            data-slot="button"
            href={paper.page}
            target="_blank"
            rel="noreferrer"
            aria-label={t`Open the paper’s page`}
            title={t`Open the paper’s page`}
          >
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : null}
        <IconButton
          label={t`Not relevant`}
          size="compact"
          className="support-dismiss"
          disabled={Boolean(busy)}
          onClick={() => claimSupport.dismiss(paper.id)}
        >
          <X size={14} />
        </IconButton>
      </div>
    </li>
  );
}

function Results({ result, busy }: { result: ClaimSupportResult; busy: ClaimSupportSnapshot["busy"] }) {
  const { t, i18n } = useLingui();
  const shown = result.papers.filter((paper) => !paper.dismissed);
  const all = result.papers.length;
  const favour = result.papers.filter((paper) => paper.signal === "supports").length;
  const inLibrary = result.papers.filter((paper) => paper.inPapers).length;
  const count = formatCount(all, i18n.locale);
  const read = formatCount(result.read, i18n.locale);
  const terms = result.terms;
  const summary = !all
    ? result.read === 0
      ? t`The search found no paper with an abstract for this claim.`
      : result.read === 1 ? t`The paper the search found does not speak to this claim.` : t`None of the ${read} papers the search found speaks to this claim.`
    : [
      all === 1 ? t`1 paper speaks to this.` : t`${count} papers speak to this, ${formatCount(favour, i18n.locale)} in favour.`,
      inLibrary === 0 ? t`None is in your library yet.`
        : inLibrary === all ? all === 1 ? t`It is in your library.` : t`All are in your library.`
        : t`${formatCount(inLibrary, i18n.locale)} already in your library.`,
      // Chinese sentences follow each other without a space.
    ].join(i18n.locale.startsWith("zh") ? "" : " ");
  return (
    <>
      <p className="support-summary">{summary}</p>
      {shown.length ? (
        <ol className="support-list">
          {shown.map((paper) => <Card key={paper.id} paper={paper} busy={busy.get(paper.id)} />)}
        </ol>
      ) : all ? <p className="support-summary">{t`Every paper has been set aside.`}</p> : null}
      <div className="support-further">
        <span>{t`Searched OpenAlex for “${terms}”`}</span>
        <Button size="compact" variant="ghost" onClick={claimSupport.searchFurther}>
          <Search size={14} aria-hidden="true" />{t`Search further`}
        </Button>
      </div>
      {all ? <p className="support-foot">{t`Passages are quoted from each paper’s abstract. Read the paper before you rely on it.`}</p> : null}
    </>
  );
}

export function SupportPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const { claim, run, result, error, busy } = useSyncExternalStore(claimSupport.subscribe, claimSupport.getSnapshot);
  return (
    <ResizableDrawer className="support-drawer" onClose={onClose}>
      <PanelHeader
        className="drawer-header"
        icon={<BookSearch size={16} />}
        title={t`Support`}
        onClose={onClose}
        actions={claim && !run ? (
          <IconButton label={t`Search again`} size="compact" onClick={claimSupport.retry}>
            <RotateCw size={14} />
          </IconButton>
        ) : null}
      />
      <div className="support-panel">
        {claim ? (
          <div className="support-body">
            <Claim claim={claim} />
            {error ? (
              <div className="support-error">
                <InlineMessage level="error">{error}</InlineMessage>
                <div><Button size="compact" variant="secondary" onClick={claimSupport.retry}>{t`Try again`}</Button></div>
              </div>
            ) : null}
            {run ? <Searching run={run} /> : result ? <Results result={result} busy={busy} /> : error ? null : (
              <div className="support-stopped">
                <p>{t`The search was stopped.`}</p>
                <Button size="compact" variant="secondary" onClick={claimSupport.retry}>{t`Search again`}</Button>
              </div>
            )}
          </div>
        ) : (
          <EmptyState
            fill
            icon={<BookSearch size={20} />}
            title={t`Find support for a claim`}
            description={t`Select a sentence in the source and choose Find support: the papers that speak to it, each with the passage that does`}
          />
        )}
      </div>
    </ResizableDrawer>
  );
}
