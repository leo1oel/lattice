/**
 * Structural renderers for multi-panel figures extracted from arXiv HTML.
 *
 * LaTeXML records a figure as flex rows whose cells carry `ltx_flex_size_N`
 * (one Nth of the row). arxiv2md preserves that as `PaperFigure` /
 * `PaperFigureRow` / `PaperFigurePanel` MDX so the visual editor does not have
 * to guess whether adjacent images belong together. `columns` is a
 * space-separated list of those denominators for one source row.
 */

import type { CSSProperties, ReactNode } from 'react';

interface PaperFigureProps {
  id?: string;
  children?: ReactNode;
}

interface PaperFigureRowProps {
  columns?: string;
  children?: ReactNode;
}

function gridColumns(value: string | undefined): string {
  if (!value) return 'minmax(0, 1fr)';
  const denominators = value
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((candidate) => Number.isFinite(candidate) && candidate >= 1 && candidate <= 24);
  if (denominators.length === 0) return 'minmax(0, 1fr)';
  return denominators
    .map((denominator) => `minmax(0, calc(100% / ${denominator}))`)
    .join(' ');
}

export function PaperFigure({ id, children }: PaperFigureProps) {
  return (
    <figure id={id} className="paper-figure">
      {children}
    </figure>
  );
}

export function PaperFigureRow({ columns, children }: PaperFigureRowProps) {
  return (
    <div
      className="paper-figure-row"
      style={{ '--paper-figure-columns': gridColumns(columns) } as CSSProperties}
    >
      {children}
    </div>
  );
}

export function PaperFigurePanel({ id, children }: PaperFigureProps) {
  return (
    <figure id={id} className="paper-figure-panel">
      {children}
    </figure>
  );
}
