import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { formatCount } from "../i18n";
import type { PaperLineHit, PaperTextMatch } from "./paper-library-search";

/** Lines a matched paper shows before "N more". */
const SHOWN_HITS = 3;

/** `text` with its highlighted ranges marked; the ranges index the string as JavaScript does. */
function marked(text: string, highlights: readonly [number, number][] = []): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of highlights) {
    if (from < at || to <= from) continue;
    if (from > at) parts.push(text.slice(at, from));
    parts.push(<mark key={from}>{text.slice(from, to)}</mark>);
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * The lines of a paper that matched a search, best first, under its row:
 * each one opens the paper at that line. A few show at once; the rest the
 * index returned come on request.
 */
export function PaperTextHits({ match, onOpen, describedBy }: {
  match: PaperTextMatch;
  onOpen: (hit: PaperLineHit) => void;
  /** The paper's title, which each line is read with. */
  describedBy?: string;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  // "N more" goes away as it is used: the keyboard moves on to the first line it brought.
  const focusFirstNewRef = useRef(false);
  useEffect(() => {
    if (!expanded || !focusFirstNewRef.current) return;
    focusFirstNewRef.current = false;
    listRef.current?.querySelectorAll<HTMLElement>(".paper-hit")[SHOWN_HITS]?.focus();
  }, [expanded]);
  const hits = match.hits ?? [];
  if (!hits.length) return null;
  const shown = expanded ? hits : hits.slice(0, SHOWN_HITS);
  const more = hits.length - shown.length;
  return (
    <ul ref={listRef} className="paper-hits">
      {shown.map((hit) => (
        <li key={`${hit.path}:${hit.line}`}>
          <button type="button" className="paper-hit" title={hit.text} aria-describedby={describedBy} onClick={() => onOpen(hit)}>
            <span className="paper-hit-text">{marked(hit.text, hit.highlights)}</span>
          </button>
        </li>
      ))}
      {more > 0 && (
        <li>
          <button type="button" className="paper-hit-more" onClick={(event) => {
            focusFirstNewRef.current = event.currentTarget === document.activeElement;
            setExpanded(true);
          }}>
            {t({ message: `${{ count: formatCount(more) }} more` })}
          </button>
        </li>
      )}
    </ul>
  );
}
