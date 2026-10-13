import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpRight, Check, ExternalLink, Pencil } from "lucide-react";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { CloseButton, IconButton } from "../components/ui/icon-button";
import { CopyButton } from "../components/copy-button";
import { stripFrontmatter } from "../app-utils";
import type { PaperSummary } from "../app-types";
import { formatCount } from "../i18n";
import { paperAuthorNames } from "../papers/paper-identity";
import { paperPdfUrl } from "../papers/paper-source";
import { citationHealthParts, citationHealthTitle } from "./citation-health";
import { paperReadingState } from "./paper-library-view";
import type { SymbolOccurrence } from "./references-panel";
import "./paper-inspector.css";

export type PaperInspectorProps = {
  projectKey: string;
  paper: PaperSummary;
  venue: string;
  /** Where the manuscript cites the paper; null until its citations are scanned. */
  usages: readonly SymbolOccurrence[] | null;
  /** Opens the paper, or downloads it first; absent when there is nothing to open. */
  onOpen?: () => void;
  onEdit: () => void;
  /** Opens the paper's web page; absent when it records none. */
  onOpenLink?: () => void;
  onOpenUse: (usage: SymbolOccurrence) => void;
  onClose: () => void;
};

/**
 * The abstract of a saved paper, read from the "Abstract" section of its full
 * text as paragraphs of plain text; null without one. ar5iv repeats the
 * heading as the first word of the text, so that word goes.
 */
function paperAbstract(markdown: string): string[] | null {
  const body = stripFrontmatter(markdown);
  const heading = /^#{1,4}[ \t]*\**Abstract\**[ \t.:]*$/im.exec(body);
  if (!heading) return null;
  const rest = body.slice(heading.index + heading[0].length);
  const end = rest.search(/^#{1,6}\s/m);
  const paragraphs = (end < 0 ? rest : rest.slice(0, end))
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph
      .replace(/<[^>]*>/g, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean);
  if (paragraphs[0]) paragraphs[0] = paragraphs[0].replace(/^Abstract\b[\s.:—-]*/i, "");
  return paragraphs.some(Boolean) ? paragraphs.filter(Boolean) : null;
}

/** The saved paper's abstract, read when the inspector shows the paper. */
function usePaperAbstract(projectKey: string, paper: PaperSummary): string[] | null {
  const id = paper.hasFullText ? paper.arxivId : "";
  const [read, setRead] = useState<{ projectKey: string; id: string; text: string[] | null } | null>(null);
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    invoke<string>("read_paper", { arxivId: id })
      .then((markdown) => {
        if (!disposed) setRead({ projectKey, id, text: paperAbstract(markdown) });
      })
      .catch(() => {
        if (!disposed) setRead({ projectKey, id, text: null });
      });
    return () => { disposed = true; };
  }, [id, projectKey]);
  return read?.projectKey === projectKey && read.id === id ? read.text : null;
}

/**
 * A use's line from just before its citation command, so the command is in
 * view however long the sentence before it runs; the end gives way to an
 * ellipsis.
 */
function citeContext(snippet: string, key: string): string {
  const text = snippet.trim();
  const at = text.toLocaleLowerCase().indexOf(key.toLocaleLowerCase());
  if (at < 0) return text;
  const command = text.lastIndexOf("\\", at);
  const anchor = command >= 0 ? command : at;
  const lead = 32;
  if (anchor <= lead) return text;
  const space = text.indexOf(" ", anchor - lead);
  return `…${text.slice(space >= 0 && space < anchor ? space + 1 : anchor - lead)}`;
}

/**
 * A wide library's detail pane for the selected paper: where it appeared and
 * when, its title and authors, what can be done with it, every place the
 * manuscript cites it (each a jump to that line), its abstract and its
 * record.
 */
export function PaperInspector(props: PaperInspectorProps) {
  const { paper } = props;
  const { t } = useLingui();
  const titleId = useId();
  const usesId = useId();
  const abstract = usePaperAbstract(props.projectKey, paper);
  const year = paper.year?.trim();
  const kicker = [props.venue, year].filter(Boolean).join(" · ");
  const names = paperAuthorNames(paper);
  const shownNames = names.length > 8 ? names.slice(0, 6) : names;
  const authors = names.length > shownNames.length
    ? t({ message: `${{ names: shownNames.join(", ") }} and ${{ count: formatCount(names.length - shownNames.length) }} more` })
    : shownNames.join(", ");
  const readingState = paperReadingState(paper);
  const citeKey = paper.citationKey;
  const arxivId = paper.arxivId.trim();
  const health = paper.citationHealth;
  const healthParts = citationHealthParts(health);
  const noticeLink = healthParts ? health?.link : undefined;
  const fullText = paper.hasFullText
    ? paper.hasBlog ? t`Saved, with its overview` : t`Saved`
    : paper.hasBlog ? t`Overview only` : readingState === "downloadable" ? t`Not downloaded` : t`Citation only`;

  return (
    <aside className="paper-inspector" aria-labelledby={titleId}>
      <div className="paper-inspector-head">
        <p className="paper-inspector-kicker">{kicker}</p>
        <CloseButton label={t`Close paper details`} size="compact" className="paper-inspector-close" onClick={props.onClose} />
      </div>
      <h2 id={titleId} className="paper-inspector-title">{paper.title}</h2>
      {authors && <p className="paper-inspector-authors">{authors}</p>}
      <div className="paper-inspector-actions">
        {props.onOpen && (
          <Button size="compact" variant="tinted" onClick={props.onOpen}>
            {readingState === "fullText" ? t`Open paper` : t`Download paper`}
          </Button>
        )}
        {citeKey && (
          <CopyButton
            className={buttonClassName({ variant: "secondary", size: "compact", className: "paper-inspector-cite" })}
            text={`\\cite{${citeKey}}`}
            iconSize={14}
            title={t`Copy \\cite command`}
          >
            <span className="paper-inspector-cite-label">{t`Copy \\cite`}</span>
          </CopyButton>
        )}
        {citeKey && (
          <IconButton label={t`Edit bibliography entry`} size="compact" onClick={props.onEdit}>
            <Pencil size={14} />
          </IconButton>
        )}
        {props.onOpenLink && (
          <IconButton label={t`Open link in browser`} size="compact" onClick={props.onOpenLink}>
            <ExternalLink size={14} />
          </IconButton>
        )}
      </div>
      {/* Every citation, in the order the manuscript reads; each opens its line. */}
      {props.usages && (
        <section className="paper-inspector-section" aria-labelledby={usesId}>
          <h3 id={usesId}>
            {t({ message: "In this paper", context: "the manuscript, where a library paper is cited" })}
            {props.usages.length > 0 && <span>{formatCount(props.usages.length)}</span>}
          </h3>
          {props.usages.length ? (
            <ul className="paper-inspector-uses">
              {props.usages.map((usage) => (
                <li key={`${usage.path}:${usage.line}:${usage.snippet}`}>
                  <button
                    type="button"
                    title={usage.snippet.trim()}
                    onClick={() => props.onOpenUse(usage)}
                  >
                    <code>{usage.path}:{usage.line}</code>
                    <span>{citeContext(usage.snippet, citeKey ?? "")}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="paper-inspector-none">{t`Not cited in this paper yet`}</p>
          )}
        </section>
      )}
      {abstract && (
        <section className="paper-inspector-section">
          <h3>{t`Abstract`}</h3>
          {abstract.map((paragraph, index) => <p key={index} className="paper-inspector-abstract">{paragraph}</p>)}
        </section>
      )}
      <section className="paper-inspector-section">
        <h3>{t`Record`}</h3>
        <dl className="paper-inspector-record">
          {citeKey && <div><dt>{t`Key`}</dt><dd><code>{citeKey}</code></dd></div>}
          {arxivId && paperPdfUrl({ arxivId }) && <div><dt>arXiv</dt><dd>{arxivId}</dd></div>}
          {paper.doi && <div><dt>DOI</dt><dd>{paper.doi}</dd></div>}
          {health && (
            <div>
              <dt>Crossref</dt>
              {healthParts ? (
                <dd className="paper-inspector-health" data-kind={health.kind} title={citationHealthTitle(health)}>
                  {/* A notice that links out opens from its own name, as the row's chip does. */}
                  {noticeLink ? (
                    <button
                      type="button"
                      className="paper-inspector-flag"
                      aria-label={t({ message: `${{ notice: healthParts.kind }}. Open notice` })}
                      onClick={() => void openUrl(noticeLink).catch(() => undefined)}
                    >
                      {healthParts.kind}
                      <ArrowUpRight size={12} aria-hidden="true" />
                    </button>
                  ) : <span className="paper-inspector-flag">{healthParts.kind}</span>}
                  {healthParts.detail && <span>{healthParts.detail}</span>}
                </dd>
              ) : health.kind === "unavailable" ? (
                <dd>{t`Unavailable right now`}</dd>
              ) : (
                <dd className="paper-inspector-health" data-kind="clear">
                  <Check size={12} aria-hidden="true" />
                  <span>{t({ message: `No notices · checked ${{ date: health.checkedAt.slice(0, 10) }}` })}</span>
                </dd>
              )}
            </div>
          )}
          <div><dt>{t`Full text`}</dt><dd>{fullText}</dd></div>
        </dl>
      </section>
    </aside>
  );
}
