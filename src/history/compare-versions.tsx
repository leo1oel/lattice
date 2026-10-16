/**
 * Any two versions compared, in place of the history timeline. The version
 * list is the picker, with From and To columns that cannot cross, so the
 * newer side is always the one on the right (Graphite's compare); the counts
 * come before the text (GitHub); the open file reads as its changed passages
 * in the reading font, each edit struck and marked as a proofread is, with
 * ‹ 1 of n › stepping between them (Linear), or as its source diff.
 *
 * "Export PDF with changes…" makes the latexdiff PDF a rebuttal or a
 * camera-ready asks for, without a terminal.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, FileDown } from "lucide-react";
import type { GitFileDiff, GitLogEntry, GitLogFileKind } from "../app-types";
import { Button } from "../components/ui/button";
import { InlineEdits } from "../components/ui/inline-edits";
import { InlineMessage } from "../components/ui/inline-message";
import { InfinityLoader } from "../components/ui/activity-icons";
import { SegmentedControl } from "../components/ui/segmented-control";
import { formatCount } from "../i18n";
import { FileKindIcon, HistoryDiff } from "./file-diff-view";
import { useLatestLoad } from "./use-latest-load";
import type { GitVersions } from "./use-git-versions";
import { isAutomaticVersion, versionMessageLabel } from "./version-messages";
import { PROSE_FILE, changedWords, joinedPassage, prosePassages, sectionAt, type ProsePassage } from "./version-prose";
import { dayName, clockTime, fullTime } from "./history-time";
import { ExportChangesDialog } from "./export-changes-dialog";
import "./compare-versions.css";

/** The newer side when it is the files as they are, not a saved version. */
const NOW = "now";

type ComparedFile = { path: string; kind: GitLogFileKind; oldPath?: string };

/** What a side is called: a version's own name, or Now. */
function sideName(side: string, entries: readonly GitLogEntry[], now: string): string {
  if (side === NOW) return now;
  const entry = entries.find((candidate) => candidate.hash === side);
  return entry ? versionMessageLabel(entry.message) : side.slice(0, 7);
}

export function CompareVersions(props: {
  versions: GitVersions;
  /** The document the project builds, which opens first and which the PDF marks. */
  rootDocument?: string;
  projectRoot?: string;
  onBack: () => void;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const { i18n, t } = useLingui();
  const { entries } = props.versions;
  const [showAutomatic, setShowAutomatic] = useState(false);
  const [chosenFrom, setFrom] = useState<string | null>(null);
  const [chosenTo, setTo] = useState(NOW);
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [mode, setMode] = useState<"prose" | "source">("prose");
  const files = useLatestLoad<ComparedFile[]>();
  const fileDiff = useLatestLoad<GitFileDiff>();
  // Until a side is picked, From is the newest version someone saved or named
  // (else the newest at all) and To is now; a picked version that leaves the
  // list (the log reloads after a restore) gives way to them again.
  const known = (hash: string | null) => Boolean(hash && entries.some((entry) => entry.hash === hash));
  const to = known(chosenTo) ? chosenTo : NOW;
  const older = entries.slice(entries.findIndex((entry) => entry.hash === to) + 1);
  const from = (known(chosenFrom) ? chosenFrom : null)
    ?? (older.find((entry) => !isAutomaticVersion(entry.message)) ?? older[0])?.hash
    ?? "";
  const toRev = to === NOW ? null : to;

  // A version a side has chosen stays listed while the automatic ones are folded away.
  const automatic = entries.filter((entry) => isAutomaticVersion(entry.message));
  const listed = entries.filter((entry) => showAutomatic || !isAutomaticVersion(entry.message) || entry.hash === from || entry.hash === to);
  const rows = [NOW, ...listed.map((entry) => entry.hash)];
  const fromIndex = rows.indexOf(from);
  const toIndex = rows.indexOf(to);

  const loadFiles = files.load;
  useEffect(() => {
    if (!from) return;
    loadFiles(`${from}:${to}`, () => invoke<ComparedFile[]>("git_compare_files", { from, to: toRev }));
  }, [from, loadFiles, to, toRev]);

  // The document the project builds opens first; then the first prose file; then whatever changed.
  const changed = files.key === `${from}:${to}` ? files.value : null;
  const shown = changed && (
    changed.find((file) => file.path === chosenPath)
    ?? changed.find((file) => file.path === props.rootDocument)
    ?? changed.find((file) => PROSE_FILE.test(file.path))
    ?? changed[0]
  );
  const path = shown?.path;
  const fromPath = shown?.oldPath ?? null;

  const loadDiff = fileDiff.load;
  useEffect(() => {
    if (!path) return;
    loadDiff(`${from}:${to}:${path}`, () => invoke<GitFileDiff>("git_compare_file", { from, to: toRev, path, fromPath }));
  }, [from, fromPath, loadDiff, path, to, toRev]);

  const diffReady = fileDiff.key === `${from}:${to}:${path}` ? fileDiff.value : null;
  const passages = path && diffReady && !diffReady.binary && PROSE_FILE.test(path) ? prosePassages(diffReady.before ?? "", diffReady.after ?? "") : null;
  // Counted as the diff found them; read with the short words between edits joined in.
  const counts = passages ? changedWords(passages) : null;
  const readable = passages?.map(joinedPassage) ?? null;
  const now = t`Now`;
  const fromName = sideName(from, entries, now);
  const toName = sideName(to, entries, now);
  const canExport = Boolean(props.rootDocument && /\.tex$/i.test(props.rootDocument) && props.projectRoot);

  const meta = (entry: GitLogEntry) => {
    const at = new Date(entry.timestamp).getTime();
    return `${dayName(at, i18n.locale)} ${clockTime(at, i18n.locale)} · ${entry.authorName || t`Unknown`}`;
  };
  const hidden = automatic.filter((entry) => !listed.includes(entry)).length;

  return (
    <div className="compare-versions">
      <CompareTop onBack={props.onBack}>
        {canExport && (
          <Button size="compact" className="compare-export" title={t`Export PDF with changes…`} onClick={() => setExporting(true)}>
            <FileDown size={13} aria-hidden="true" />
            <span>{t`Export PDF with changes…`}</span>
          </Button>
        )}
      </CompareTop>
      <div className="compare-heading">
        <h2>{t`Compare versions`}</h2>
        <p>{t`Pick where to start and where to end. The newer version is always on the right.`}</p>
      </div>
      <div className="compare-picker" role="table" aria-label={t`Versions to compare`}>
        <div className="compare-picker-head" role="row">
          <span role="columnheader">{t`Version`}</span>
          <span role="columnheader">{t`From`}</span>
          <span role="columnheader">{t`To`}</span>
        </div>
        <div className="compare-picker-rows native-hover-scrollbar">
          {rows.map((side, index) => {
            const entry = entries.find((candidate) => candidate.hash === side);
            const name = sideName(side, entries, now);
            const inRange = index >= toIndex && index <= fromIndex;
            return (
              <div key={side} className="compare-picker-row" role="row" data-in-range={inRange || undefined} data-automatic={(entry && isAutomaticVersion(entry.message)) || undefined}>
                <span role="cell" className="compare-picker-name" title={entry ? fullTime(new Date(entry.timestamp).getTime(), i18n.locale) : undefined}>
                  <b title={name}>{name}</b>
                  <em>{entry ? meta(entry) : t`Including changes not saved as a version`}</em>
                </span>
                <span role="cell">
                  <input type="radio" name="compare-from" aria-label={t`From ${name}`} checked={from === side} disabled={index <= toIndex} onChange={() => setFrom(side)} />
                </span>
                <span role="cell">
                  <input type="radio" name="compare-to" aria-label={t`To ${name}`} checked={to === side} disabled={index >= fromIndex} onChange={() => setTo(side)} />
                </span>
              </div>
            );
          })}
        </div>
        {automatic.length > 0 && (
          <button type="button" className="compare-picker-more" aria-expanded={showAutomatic} onClick={() => setShowAutomatic((shown) => !shown)}>
            {showAutomatic ? t`Hide automatic versions` : t`Show ${formatCount(hidden)} automatic versions`}
          </button>
        )}
        {props.versions.hasOlder && (
          <button type="button" className="compare-picker-more" disabled={props.versions.refreshing} onClick={() => void props.versions.loadOlder()}>
            {t`Load older versions`}
          </button>
        )}
      </div>

      <div className="compare-bar">
        <span className="compare-range" aria-live="polite">
          <b title={fromName}>{fromName}</b>
          <ArrowRight size={12} aria-hidden="true" />
          <b title={toName}>{toName}</b>
        </span>
        {passages && (
          <SegmentedControl
            className="compare-mode"
            value={mode}
            onChange={setMode}
            ariaLabel={t`Show changes as`}
            items={[{ value: "prose", label: t`Prose` }, { value: "source", label: t`Source` }]}
          />
        )}
      </div>
      {files.error && <InlineMessage level="error">{files.error}</InlineMessage>}
      {!changed && !files.error && <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Comparing…`}</p>}
      {changed && !changed.length && <p className="compare-none">{t`These two versions have the same files.`}</p>}
      {changed && changed.length > 1 && (
        <div className="version-files" role="group" aria-label={t`Changed files`}>
          {changed.map((file) => (
            <button
              key={file.path}
              type="button"
              className={`version-file${path === file.path ? " active" : ""}`}
              aria-pressed={path === file.path}
              title={file.path}
              onClick={() => setChosenPath(file.path)}
            >
              <FileKindIcon kind={file.kind} />
              <span>{file.path}</span>
            </button>
          ))}
        </div>
      )}
      {path && fileDiff.error && <InlineMessage level="error">{fileDiff.error}</InlineMessage>}
      {path && !fileDiff.error && !diffReady && <p className="history-diff-loading"><InfinityLoader size={12} /> {t`Loading diff…`}</p>}
      {path && diffReady && (
        <ComparedFileChanges
          key={`${from}:${to}:${path}`}
          path={path}
          diff={diffReady}
          passages={mode === "prose" ? readable : null}
          counts={counts}
          onOpenLine={to === NOW && props.onOpenFile ? (line) => props.onOpenFile?.(path, line) : undefined}
        />
      )}
      {exporting && props.projectRoot && props.rootDocument && (
        <ExportChangesDialog
          projectRoot={props.projectRoot}
          rootDocument={props.rootDocument}
          from={from}
          to={toRev}
          fromName={fromName}
          toName={toName}
          changed={changed}
          onOpenFile={props.onOpenFile}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}

function CompareTop(props: { onBack: () => void; children?: ReactNode }) {
  const { t } = useLingui();
  return (
    <div className="compare-top">
      <button type="button" className="compare-back" onClick={props.onBack}>
        <ArrowLeft size={13} aria-hidden="true" />
        <span>{t`History`}</span>
      </button>
      {props.children}
    </div>
  );
}

/**
 * The open file between the two sides: its changed passages as prose with the
 * counts above them, or (without `passages`) its source diff.
 */
function ComparedFileChanges(props: {
  path: string;
  diff: GitFileDiff;
  passages: ProsePassage[] | null;
  counts: { added: number; removed: number } | null;
  onOpenLine?: (line: number) => void;
}) {
  const { t } = useLingui();
  const { counts, diff, path, passages } = props;
  const [current, setCurrent] = useState(0);
  const passageRefs = useRef<Array<HTMLElement | null>>([]);
  if (!passages) return <HistoryDiff change={{ path, before: diff.before, after: diff.after }} binary={diff.binary} />;

  const step = (by: number) => {
    const next = Math.min(passages.length - 1, Math.max(0, current + by));
    setCurrent(next);
    passageRefs.current[next]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    passageRefs.current[next]?.focus({ preventScroll: true });
  };
  const paragraphs = formatCount(passages.length);
  const after = diff.after ?? diff.before ?? "";
  return (
    <div className="compare-file">
      <div className="compare-counts">
        <span className="compare-summary">
          <span className="compare-path" title={path}>{path}</span>
          {" · "}
          <span>{passages.length === 1 ? t`1 changed paragraph` : t`${paragraphs} changed paragraphs`}</span>
          {counts && (
            <span className="compare-words">
              <span className="compare-plus">+{formatCount(counts.added)}</span>
              <span className="compare-minus">−{formatCount(counts.removed)}</span>
              {t({ message: "words", context: "changed words count" })}
            </span>
          )}
        </span>
        {passages.length > 1 && (
          <span className="compare-step" role="group" aria-label={t`Changes`}>
            <button type="button" aria-label={t`Previous change`} disabled={current === 0} onClick={() => step(-1)}>
              <ChevronUp size={13} aria-hidden="true" />
            </button>
            <span>{t`${formatCount(current + 1)} of ${paragraphs}`}</span>
            <button type="button" aria-label={t`Next change`} disabled={current === passages.length - 1} onClick={() => step(1)}>
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      {!passages.length && <p className="compare-none">{t`No textual changes`}</p>}
      <div className="compare-passages" aria-label={t`Changes in ${path}`}>
        {passages.map((passage, index) => {
          const section = sectionAt(after, passage.line);
          const where = t`Line ${passage.line}`;
          const label = section ? `${section} · ${where}` : where;
          return (
            <section
              key={`${passage.line}:${index}`}
              ref={(node) => { passageRefs.current[index] = node; }}
              className="compare-passage"
              data-current={(passages.length > 1 && index === current) || undefined}
              tabIndex={-1}
            >
              <h3>
                {props.onOpenLine ? (
                  <button type="button" title={t`Open ${path} at line ${passage.line}`} onClick={() => props.onOpenLine?.(passage.line)}>
                    {label}
                  </button>
                ) : label}
              </h3>
              <div className="compare-passage-text">
                {passage.clippedStart && <span className="version-passage-gap" aria-hidden="true">… </span>}
                <InlineEdits text={passage.text} edits={passage.edits} />
                {passage.clippedEnd && <span className="version-passage-gap" aria-hidden="true"> …</span>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
