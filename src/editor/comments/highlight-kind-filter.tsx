import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, ChevronDown, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { formatCount } from "../../i18n";

// eslint-disable-next-line lingui/no-unlocalized-strings -- a type specimen on a highlighter's tint, not copy
const SPECIMEN = "Aa";
/** The kind of a highlight in none of the six highlighters' colours. */
export const OTHER = "other";

/**
 * The Annotations panel's colour filter over the open file's highlights: the
 * chosen highlighter (or a stack of the colours present) opening a menu of
 * each with its count, and a clear button while one is chosen.
 */
export function HighlightKindFilter({ kind: chosen, kinds, total, kindLabel, onChange }: {
  /** The highlighter shown (its hex, or `OTHER`), or null for every colour. */
  kind: string | null;
  /** The kinds present, in the highlighters' order, with their counts. */
  kinds: ReadonlyArray<{ kind: string; count: number }>;
  total: number;
  kindLabel: (kind: string) => string;
  onChange: (kind: string | null) => void;
}) {
  const { i18n, t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="annotations-kind-filter" data-active={chosen ? true : undefined}>
        <PopoverTrigger asChild>
          <button type="button" className="annotations-kind-trigger" aria-label={t`Filter highlights by colour`}>
            {chosen ? (
              <>
                <span className="annotations-kind-chip" style={chosen === OTHER ? undefined : { background: chosen }} data-kind={chosen === OTHER ? OTHER : undefined} aria-hidden>{SPECIMEN}</span>
                <span className="annotations-kind-label">{kindLabel(chosen)}</span>
              </>
            ) : (
              <>
                <span className="annotations-kind-stack" aria-hidden>
                  {kinds.slice(0, 4).map(({ kind }) => <i key={kind} style={kind === OTHER ? undefined : { background: kind }} data-kind={kind === OTHER ? OTHER : undefined} />)}
                </span>
                <span className="annotations-kind-label">{t`All colours`}</span>
              </>
            )}
            <ChevronDown size={12} strokeWidth={1.8} aria-hidden />
          </button>
        </PopoverTrigger>
        {chosen && (
          <button type="button" className="annotations-kind-clear" aria-label={t`Show all colours`} onClick={() => onChange(null)}>
            <X size={12} strokeWidth={1.8} />
          </button>
        )}
      </span>
      <PopoverContent side="bottom" align="start" sideOffset={6} className="annotations-kind-menu">
        {[{ kind: null as string | null, count: total }, ...kinds].map(({ kind, count }) => (
          <button
            type="button"
            key={kind ?? "all"}
            className="annotations-kind-row"
            aria-pressed={chosen === kind}
            onClick={() => {
              onChange(kind);
              setOpen(false);
            }}
          >
            {kind
              ? <span className="annotations-kind-chip" style={kind === OTHER ? undefined : { background: kind }} data-kind={kind === OTHER ? OTHER : undefined} aria-hidden>{SPECIMEN}</span>
              : <span className="annotations-kind-stack" aria-hidden>{kinds.slice(0, 3).map((item) => <i key={item.kind} style={item.kind === OTHER ? undefined : { background: item.kind }} />)}</span>}
            <span className="annotations-kind-row-label">{kind ? kindLabel(kind) : t`All highlights`}</span>
            <span className="annotations-kind-row-count">{formatCount(count, i18n.locale)}</span>
            {chosen === kind ? <Check size={13} strokeWidth={1.8} aria-hidden /> : <span />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
