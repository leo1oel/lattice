import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, History, RotateCcw } from "lucide-react";
import { tokenHunks } from "../../agent/proofread-edits";
import { confirmAction, toMessage } from "../../app-utils";
import { InfinityLoader } from "../../components/ui/activity-icons";
import { Button } from "../../components/ui/button";
import { EmptyIllustration } from "../../components/ui/empty-illustration";
import { EmptyState } from "../../components/ui/empty-state";
import { IconButton } from "../../components/ui/icon-button";
import { InlineMessage } from "../../components/ui/inline-message";
import { PanelHeader } from "../../components/ui/panel-header";
import { SheetDialog } from "../../components/ui/sheet-dialog";
import type { AnnotationRound, EditorComment } from "./editor-comment-data";
import "./annotations.css";

/** A file's text as a round found it and left it (`save_annotation_round`). */
type RoundFile = { path: string; before: string | null; after: string | null };

/** A version on the rail: the live project, a round as it left the files, or before the first round. */
type Version = { key: string; kind: "now" | "round" | "before"; round?: AnnotationRound };

/** One paragraph that differs between the two versions, with the annotations behind it. */
type ChangedParagraph = { path: string; older: string; newer: string; numbers: number[] };

/** Every settled round's files, and the live text of each file they touched. */
async function readRounds(settled: readonly AnnotationRound[], readSource: (path: string) => Promise<string | null>) {
  const loaded = new Map<number, RoundFile[]>();
  for (const round of settled) loaded.set(round.number, await invoke<RoundFile[]>("read_annotation_round", { number: round.number }));
  const live = new Map<string, string | null>();
  for (const path of new Set([...loaded.values()].flat().map((file) => file.path))) live.set(path, await readSource(path));
  return { loaded, live };
}

/** A round's date and time, short: "Oct 12, 2:20 PM". */
const dateTime = (locale: string) => new Intl.DateTimeFormat(locale, {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Intl option values
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** The lines of a source, compared without the spaces around them. */
const sourceLines = (text: string) => text.split("\n").map((line) => line.trim());

/**
 * The runs of lines that differ between `older` and `newer`, each run's lines
 * joined, paired in order around the longest common run of equal lines. A
 * paper written a sentence or a paragraph to a line compares by sentence or
 * paragraph; blank lines alone are no change.
 */
function changedParagraphs(older: string, newer: string): Array<{ older: string; newer: string }> {
  const a = sourceLines(older);
  const b = sourceLines(newer);
  const n = a.length;
  const m = b.length;
  // Lengths of the longest common runs of equal lines, from each end.
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const changes: Array<{ older: string; newer: string }> = [];
  let pending = { older: [] as string[], newer: [] as string[] };
  const flush = () => {
    const change = { older: pending.older.filter(Boolean).join("\n"), newer: pending.newer.filter(Boolean).join("\n") };
    if (change.older || change.newer) changes.push(change);
    pending = { older: [], newer: [] };
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      pending.newer.push(b[j]!);
      j += 1;
    } else {
      pending.older.push(a[i]!);
      i += 1;
    }
  }
  flush();
  return changes;
}

/** `text` read as prose, with the spans `marked` drawn as `<del>` or `<ins>`. */
function marked(text: string, spans: Array<{ from: number; to: number }>, Mark: "del" | "ins"): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    if (span.to <= span.from) continue;
    parts.push(text.slice(cursor, span.from));
    parts.push(<Mark key={index}>{text.slice(span.from, span.to)}</Mark>);
    cursor = span.to;
  }
  parts.push(text.slice(cursor));
  return parts;
}

/** The older paragraph with what the newer one dropped struck, and the newer with what it added marked. */
function sides(older: string, newer: string): [ReactNode, ReactNode] {
  const hunks = tokenHunks(older, newer);
  const deleted = hunks.map((hunk) => ({ from: hunk.from, to: hunk.to }));
  // The same hunks, measured in the newer text.
  const inserted: Array<{ from: number; to: number }> = [];
  let shift = 0;
  for (const hunk of hunks) {
    const from = hunk.from + shift;
    inserted.push({ from, to: from + hunk.insert.length });
    shift += hunk.insert.length - (hunk.to - hunk.from);
  }
  return [marked(older, deleted, "del"), marked(newer, inserted, "ins")];
}

/**
 * Every revision round as a version: the rail lists Now, each round (newest
 * first, with what became of its annotations) and the text before revisions;
 * choosing one compares it side by side with the version before it (or any
 * older one), each changed paragraph tagged with the annotations behind it.
 * A round opens in the project history, and any version can be restored.
 */
export function AnnotationRoundsDialog(props: {
  rounds: readonly AnnotationRound[];
  annotations: readonly EditorComment[];
  /** A file's current text: the open buffer, else the disk. */
  readSource: (path: string) => Promise<string | null>;
  onOpenInHistory: (historyId: string) => void;
  /** Write `files` (path → text) as one restore; resolves once the project is reloaded. */
  onRestore: (label: string, files: Array<{ path: string; text: string }>) => Promise<void>;
  onClose: () => void;
}) {
  const { i18n, t } = useLingui();
  const settled = useMemo(() => props.rounds.filter((round) => round.settledAt), [props.rounds]);
  const [snapshots, setSnapshots] = useState<Map<number, RoundFile[]> | null>(null);
  const [now, setNow] = useState<Map<string, string | null> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const versions = useMemo((): Version[] => [
    { key: "now", kind: "now" },
    ...[...settled].reverse().map((round): Version => ({ key: `round:${round.number}`, kind: "round", round })),
    { key: "before", kind: "before" },
  ], [settled]);
  const [selected, setSelected] = useState<string>(() => versions[1]?.key ?? "now");
  const [base, setBase] = useState<string | null>(null);
  const changesRef = useRef<HTMLDivElement>(null);
  /** The change the arrows are on, for the pair of versions it was chosen in. */
  const [cursor, setCursor] = useState<{ pair: string; index: number }>({ pair: "", index: 0 });
  const { readSource } = props;

  // Every settled round's files, then the live text of each file they touched.
  useEffect(() => {
    let cancelled = false;
    void readRounds(settled, readSource).then(
      ({ loaded, live }) => {
        if (cancelled) return;
        setSnapshots(loaded);
        setNow(live);
      },
      (reason: unknown) => {
        if (!cancelled) setError(toMessage(reason));
      },
    );
    return () => { cancelled = true; };
  }, [readSource, settled]);

  /** Each file's text in a version: after the last round up to it that touched the file, else before the first that did. */
  const textAt = (version: Version): Map<string, string | null> => {
    const texts = new Map<string, string | null>();
    if (!snapshots || !now) return texts;
    if (version.kind === "now") return new Map(now);
    const ordered = settled.filter((round) => snapshots.has(round.number));
    for (const round of ordered) {
      for (const file of snapshots.get(round.number) ?? []) if (!texts.has(file.path)) texts.set(file.path, file.before);
    }
    if (version.kind === "before") return texts;
    for (const round of ordered) {
      if (round.number > version.round!.number) break;
      for (const file of snapshots.get(round.number) ?? []) texts.set(file.path, file.after);
    }
    return texts;
  };

  const selectedIndex = Math.max(0, versions.findIndex((version) => version.key === selected));
  const newer = versions[selectedIndex]!;
  const olderChoices = versions.slice(selectedIndex + 1);
  const older = olderChoices.find((version) => version.key === base) ?? olderChoices[0] ?? null;

  const changes = ((): ChangedParagraph[] => {
    if (!older || !snapshots || !now) return [];
    const before = textAt(older);
    const after = textAt(newer);
    const rounds = new Set(settled
      .filter((round) => (older.kind === "before" || round.number > (older.round?.number ?? 0))
        && (newer.kind === "now" || round.number <= (newer.round?.number ?? 0)))
      .map((round) => round.number));
    const accepted = props.annotations.filter((annotation) => annotation.revision?.state === "accepted"
      && rounds.has(annotation.revision.round));
    return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => changedParagraphs(before.get(path) ?? "", after.get(path) ?? "")
      .map((change) => ({
        path,
        ...change,
        numbers: accepted
          .filter((annotation) => annotation.path === path && annotation.quote.trim() && change.newer.includes(annotation.quote.trim()))
          .map((annotation) => annotation.number ?? 0)
          .sort((a, b) => a - b),
      })));
  })();

  const pair = `${older?.key ?? ""}>${newer.key}`;
  const changeIndex = cursor.pair === pair ? cursor.index : 0;
  const goTo = (index: number) => {
    const target = changesRef.current?.querySelectorAll<HTMLElement>(".annotation-compare-row")[index];
    if (!target) return;
    setCursor({ pair, index });
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const label = (version: Version) => version.kind === "now" ? t`Now`
    : version.kind === "before" ? t`Before revisions` : t`Round ${version.round!.number}`;
  const when = (iso: string | undefined) => iso ? dateTime(i18n.locale).format(new Date(iso)) : "";
  const outcome = (round: AnnotationRound) => {
    const values = Object.values(round.outcomes);
    const accepted = values.filter((value) => value === "accepted").length;
    const rejected = values.filter((value) => value === "rejected").length;
    const open = values.length - accepted - rejected;
    return [
      accepted ? t`${accepted} accepted` : null,
      rejected ? t`${rejected} rejected` : null,
      open ? t`${open} open` : null,
    ].filter(Boolean).join(" · ");
  };

  const restore = async () => {
    if (newer.kind === "now") return;
    const name = label(newer);
    if (!await confirmAction(t`Restore the files the rounds touched to ${name}? The restore is added to the project history, so it can be undone there.`)) return;
    const texts = textAt(newer);
    const files = [...texts].flatMap(([path, text]) => text === null || text === now?.get(path) ? [] : [{ path, text }]);
    if (!files.length) {
      setError(t`The files already read as ${name}.`);
      return;
    }
    setRestoring(true);
    await props.onRestore(t`Restore ${name}`, files).then(
      () => props.onClose(),
      (reason: unknown) => {
        setError(toMessage(reason));
        setRestoring(false);
      },
    );
  };

  const nowEdited = Boolean(now && snapshots && settled.length && [...textAt(versions[1]!)].some(([path, text]) => now.get(path) !== text));
  const historyId = newer.kind === "round" ? newer.round?.historyId : undefined;
  return (
    <SheetDialog label={t`Revision rounds`} className="annotation-rounds" onClose={props.onClose}>
      <PanelHeader className="drawer-header" icon={<History size={16} />} title={t`Revision rounds`} onClose={props.onClose} />
      <div className="annotation-rounds-body">
        <nav className="annotation-rounds-rail" aria-label={t`Versions`}>
          {versions.map((version) => (
            <button
              type="button"
              key={version.key}
              className="annotation-version"
              aria-current={version.key === newer.key || undefined}
              data-base={version.key === older?.key || undefined}
              onClick={() => {
                setSelected(version.key);
                setBase(null);
              }}
            >
              <span className="annotation-version-name">{label(version)}</span>
              <span className="annotation-version-detail">
                {version.kind === "now"
                  ? nowEdited ? t`Edited since the last round` : t`As the last round left it`
                  : version.kind === "before"
                    ? when(settled[0]?.startedAt)
                    : [when(version.round!.settledAt), Object.keys(version.round!.outcomes).length === 1
                      ? t`1 annotation`
                      : t`${Object.keys(version.round!.outcomes).length} annotations`].join(" · ")}
              </span>
              {version.kind === "round" && <span className="annotation-version-tag">{outcome(version.round!)}</span>}
            </button>
          ))}
        </nav>
        <section className="annotation-compare" aria-label={t`Compare versions`}>
          <div className="annotation-compare-bar">
            <span className="annotation-compare-title">
              {older ? t`${label(older)} → ${label(newer)}` : label(newer)}
            </span>
            {changes.length > 0 && (
              <span className="annotation-compare-count">
                {changes.length === 1 ? t`1 change` : t`${changes.length} changes`}
                <IconButton size="compact" label={t`Previous change`} disabled={changeIndex <= 0} onClick={() => goTo(changeIndex - 1)}>
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton size="compact" label={t`Next change`} disabled={changeIndex >= changes.length - 1} onClick={() => goTo(changeIndex + 1)}>
                  <ArrowDown size={13} />
                </IconButton>
              </span>
            )}
            <span className="annotation-compare-actions">
              {historyId && (
                <Button size="compact" variant="ghost" onClick={() => props.onOpenInHistory(historyId)}>
                  {t`Open in History`}
                </Button>
              )}
              {newer.kind !== "now" && (
                <Button size="compact" variant="ghost" disabled={restoring || !snapshots} onClick={() => void restore()}>
                  <RotateCcw size={13} />
                  {t`Restore ${label(newer)}`}
                </Button>
              )}
            </span>
          </div>
          {error && <InlineMessage level="error">{error}</InlineMessage>}
          {!snapshots || !now ? (
            <p className="annotation-compare-loading"><InfinityLoader size={12} /> {t`Reading the rounds…`}</p>
          ) : !older ? (
            <EmptyState icon={<EmptyIllustration kind="history" />} description={t`This is the earliest version`} />
          ) : !changes.length ? (
            <EmptyState icon={<EmptyIllustration kind="history" />} description={t`The two versions read the same`} />
          ) : (
            <div className="annotation-compare-columns" ref={changesRef}>
              <div className="annotation-compare-head">
                <span>{label(older)}</span>
                <span>{label(newer)}</span>
              </div>
              {changes.map((change, index) => {
                const [left, right] = sides(change.older, change.newer);
                const showPath = index === 0 || changes[index - 1]!.path !== change.path;
                return (
                  <Fragment key={`${change.path}:${index}`}>
                    {showPath && new Set(changes.map((item) => item.path)).size > 1 && (
                      <h3 className="annotation-compare-file">{change.path}</h3>
                    )}
                    <div className="annotation-compare-row" data-current={index === changeIndex || undefined}>
                      <p className="annotation-compare-text">{change.older ? left : <em>{t`(new paragraph)`}</em>}</p>
                      <p className="annotation-compare-text">
                        {change.numbers.map((number) => <span key={number} className="annotation-compare-marker">{number}</span>)}
                        {change.newer ? right : <em>{t`(removed)`}</em>}
                      </p>
                    </div>
                  </Fragment>
                );
              })}
            </div>
          )}
          {olderChoices.length > 1 && (
            <div className="annotation-compare-base" role="group" aria-label={t`Compare with`}>
              <span>{t`Compare with`}</span>
              {olderChoices.map((version) => (
                <button
                  type="button"
                  key={version.key}
                  className="annotation-compare-base-option"
                  aria-pressed={version.key === older?.key}
                  onClick={() => setBase(version.key)}
                >
                  {label(version)}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </SheetDialog>
  );
}
