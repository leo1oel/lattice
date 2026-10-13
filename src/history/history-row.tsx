/**
 * One row of the project history timeline, whatever recorded it: a glyph on
 * the day's rail, what happened as the title, who and what in a meta line,
 * the clock time at the right, and the row's actions waiting behind the time
 * until the pointer or keyboard focus reaches the row. Versions, Lattice's
 * activity and Overleaf's history all draw through this, so the three read as
 * one record.
 */
import type { ReactNode } from "react";
import { peerColorForName, peerInitials } from "../components/ui/collab-colors";
import { cn } from "@/lib/utils";

/**
 * How much a row asks to be read: `named` is a version someone chose to keep
 * (a filled glyph and a medium title), `quiet` one Lattice made on its own,
 * `plain` everything else.
 */
export type HistoryRowWeight = "named" | "plain" | "quiet";

export function HistoryRow(props: {
  glyph: ReactNode;
  weight?: HistoryRowWeight;
  /** A data hook for styling the glyph by who made the row (`agent`, `overleaf`, …). */
  tone?: string;
  title: ReactNode;
  meta?: ReactNode;
  time: string;
  timeTitle?: string;
  /** Where the row came from, named when the timeline shows more than one source. */
  source?: string;
  expanded: boolean;
  onToggle: () => void;
  /** Icon actions shown on hover and focus in place of the time. */
  tools?: ReactNode;
  children?: ReactNode;
  className?: string;
  "data-history-entry"?: string;
}) {
  return (
    <li
      className={cn("history-row", props.expanded && "expanded", props.className)}
      data-weight={props.weight ?? "plain"}
      data-tone={props.tone}
      data-history-entry={props["data-history-entry"]}
    >
      <span className="history-row-glyph" aria-hidden="true">{props.glyph}</span>
      <button type="button" className="history-row-head" aria-expanded={props.expanded} onClick={props.onToggle}>
        <span className="history-row-title">{props.title}</span>
        <time className="history-row-time" title={props.timeTitle}>{props.time}</time>
        {props.meta && <span className="history-row-meta">{props.meta}</span>}
        {props.source && <span className="history-row-source">{props.source}</span>}
      </button>
      {props.tools && <span className="history-row-tools">{props.tools}</span>}
      {props.expanded && props.children && <div className="history-row-body">{props.children}</div>}
    </li>
  );
}

/** A day's heading and its rows; the heading stays in view while its rows scroll under it. */
export function HistoryDay(props: { label: string; children: ReactNode }) {
  return (
    <section className="history-day">
      <h3 className="history-day-label">{props.label}</h3>
      <ol className="history-day-rows">{props.children}</ol>
    </section>
  );
}

/** A person in a meta line: initials in their colour, then the name, which gives way first when the row narrows. */
export function HistoryPerson(props: { name: string; suffix?: string }) {
  const color = peerColorForName(props.name).color;
  return (
    <span className="history-person">
      <span className="history-avatar" style={{ background: color }} aria-hidden="true">{peerInitials(props.name)}</span>
      <span className="history-person-name">{props.name}{props.suffix}</span>
    </span>
  );
}

/** "+12 −3", the lines a change added and removed. */
export function HistoryStat(props: { additions: number; deletions: number; format: (value: number) => string }) {
  if (!props.additions && !props.deletions) return null;
  return (
    <span className="history-stat">
      <span className="history-stat-add">+{props.format(props.additions)}</span>{" "}
      <span className="history-stat-del">−{props.format(props.deletions)}</span>
    </span>
  );
}
