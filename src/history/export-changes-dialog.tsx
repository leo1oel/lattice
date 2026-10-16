/**
 * The PDF with changes marked, as a sheet over the comparison: how the
 * changes are drawn on the left, a page drawn that way on the right (Craft's
 * export, options beside a live preview). No app on Mobbin exports a
 * comparison; this is the step a rebuttal or a camera-ready asks for, and the
 * one writers otherwise run latexdiff in a terminal for.
 *
 * The preview is the comparison's own first changes, drawn the way latexdiff
 * draws them, not the typeset page: building one takes as long as the export.
 */
import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpDown, FileDown } from "lucide-react";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { InfinityLoader } from "../components/ui/activity-icons";
import { ModalDialog } from "../components/ui/modal-dialog";
import { SegmentedControl } from "../components/ui/segmented-control";
import { SwitchField } from "../components/ui/switch-field";
import { inlineEditSpans } from "../components/ui/inline-edit-spans";
import { projectItemPath, toMessage } from "../app-utils";
import { logAction } from "../telemetry/app-notify";
import type { GitFileDiff } from "../app-types";
import { joinedPassage, prosePassages, type ProsePassage } from "./version-prose";
import { useLatestLoad } from "./use-latest-load";

export type ChangesPdfOptions = {
  colour: boolean;
  keepDeleted: boolean;
  marginBars: boolean;
  onlyChangedPages: boolean;
};

type ChangesPdf = { path: string; simplified: boolean };

/** The last choices, for the next export this session. */
let lastOptions: ChangesPdfOptions = { colour: true, keepDeleted: true, marginBars: true, onlyChangedPages: false };

/** How many changed passages the page preview draws. */
const PREVIEW_PASSAGES = 3;

/** `main.tex` → `main-changes.pdf`, where the export saves it (and the backend agrees). */
function changesPdfName(rootDocument: string): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a file name
  return `${rootDocument.replace(/\.tex$/i, "")}-changes.pdf`;
}

/**
 * The first changed passages across the comparison's .tex files, in order.
 * A module helper: the compiler cannot compile `??` inside the loop of a
 * closure, which would skip the whole dialog.
 */
async function previewPassages(
  from: string,
  to: string | null,
  sources: ReadonlyArray<{ path: string; oldPath?: string }>,
): Promise<ProsePassage[]> {
  const passages: ProsePassage[] = [];
  for (const file of sources) {
    if (passages.length >= PREVIEW_PASSAGES) break;
    const diff = await invoke<GitFileDiff>("git_compare_file", { from, to, path: file.path, fromPath: file.oldPath ?? null });
    if (diff.binary) continue;
    const found = prosePassages(diff.before ?? "", diff.after ?? "") ?? [];
    passages.push(...found.map(joinedPassage).filter((passage) => passage.edits.length));
  }
  return passages.slice(0, PREVIEW_PASSAGES);
}

export function ExportChangesDialog(props: {
  projectRoot: string;
  rootDocument: string;
  /** The older side's commit. */
  from: string;
  /** The newer side's commit, or null for the files now. */
  to: string | null;
  fromName: string;
  toName: string;
  /** The files the comparison changed; the preview reads its .tex files, the root document first. */
  changed: ReadonlyArray<{ path: string; oldPath?: string }> | null;
  onOpenFile?: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [options, setOptions] = useState(lastOptions);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const set = (change: Partial<ChangesPdfOptions>) => {
    const next = { ...options, ...change };
    lastOptions = next;
    setOptions(next);
  };
  const saved = changesPdfName(props.rootDocument);
  const pdf = props.rootDocument.replace(/\.tex$/i, ".pdf");
  const preview = useLatestLoad<ProsePassage[]>();
  const loadPreview = preview.load;
  const { changed, from, rootDocument, to } = props;
  useEffect(() => {
    if (!changed) return;
    const sources = changed
      .filter((file) => /\.tex$/i.test(file.path))
      .sort((a, b) => Number(b.path === rootDocument) - Number(a.path === rootDocument));
    loadPreview(`${from}:${to}`, () => previewPassages(from, to, sources));
  }, [changed, from, loadPreview, rootDocument, to]);
  const shown = preview.value ?? [];

  // Worded outside the try: the compiler cannot compile a conditional inside one.
  const savedNotice = (result: ChangesPdf) => ({
    detail: result.simplified
      ? t`Maths, figures and citations are left unmarked: the fully marked document did not build.`
      : undefined,
    primaryAction: props.onOpenFile ? { label: t`Open`, onClick: () => props.onOpenFile?.(result.path) } : undefined,
    secondaryAction: {
      label: t`Show in Finder`,
      onClick: () => revealItemInDir(projectItemPath(props.projectRoot, result.path)).catch(() => undefined),
    },
  });
  const failure = (message: string) => message.startsWith("latexdiff is not installed")
    ? t`latexdiff is not installed. It comes with MacTeX; with BasicTeX, run “sudo tlmgr install latexdiff” in Terminal, then export again.`
    : message;

  const exportPdf = async () => {
    setRunning(true);
    setError("");
    const trace = logAction(t`History`, t`Export PDF with changes marked`, `${props.fromName} → ${props.toName}`);
    try {
      const result = await invoke<ChangesPdf>("export_changes_pdf", {
        projectRoot: props.projectRoot,
        from: props.from,
        to: props.to,
        options,
      });
      trace.ok(t`Saved ${result.path}`, savedNotice(result));
      props.onClose();
    } catch (reason) {
      // Said in the sheet, where the choices that may fix it are.
      trace.fail(reason, { toast: false });
      setError(failure(toMessage(reason)));
      setRunning(false);
    }
  };

  return (
    <ModalDialog label={t`Export PDF with changes marked`} closeDisabled={running} keepOnOutsideClick={running} onClose={props.onClose}>
      <div className="modal export-changes-modal" data-preview={shown.length > 0 || undefined}>
        <div className="export-changes-form">
          <h2>{t`PDF with changes marked`}</h2>
          <p className="export-changes-range">
            <b title={props.fromName}>{props.fromName}</b>
            <ArrowUpDown size={12} aria-hidden="true" />
            <b title={props.toName}>{props.toName}</b>
          </p>
          <div className="export-changes-field">
            <span id="export-changes-style">{t`Mark changes`}</span>
            <SegmentedControl
              value={options.colour ? "colour" : "underline"}
              onChange={(value) => set({ colour: value === "colour" })}
              ariaLabel={t`Mark changes`}
              items={[{ value: "colour", label: t`In colour` }, { value: "underline", label: t`Underline only` }]}
            />
          </div>
          <SwitchField
            className="export-changes-switch"
            label={t`Keep deleted text, struck through`}
            description={t`Reviewers see what was removed`}
            checked={options.keepDeleted}
            onChange={(keepDeleted) => set({ keepDeleted })}
          />
          <SwitchField
            className="export-changes-switch"
            label={t`Bars in the margin`}
            description={t`A line beside every change`}
            checked={options.marginBars}
            onChange={(marginBars) => set({ marginBars })}
          />
          <SwitchField
            className="export-changes-switch"
            label={t`Only pages with changes`}
            description={t`Pages nothing changed on are left out`}
            checked={options.onlyChangedPages}
            onChange={(onlyChangedPages) => set({ onlyChangedPages })}
          />
          <p className="export-changes-note">
            {t`Made with latexdiff from your TeX installation, then built like the paper. Saved as ${saved} beside ${pdf}.`}
          </p>
          {error && <InlineMessage level="error">{error}</InlineMessage>}
          <div className="modal-actions">
            <Button variant="ghost" disabled={running} onClick={props.onClose}>{t`Cancel`}</Button>
            <Button variant="primary" autoFocus disabled={running} onClick={() => void exportPdf()}>
              {running ? <InfinityLoader size={14} /> : <FileDown size={14} aria-hidden="true" />}
              {running ? t`Exporting…` : t`Export PDF`}
            </Button>
          </div>
        </div>
        {shown.length > 0 && (
          <div className="export-changes-preview" aria-hidden="true" data-colour={options.colour || undefined} data-bars={options.marginBars || undefined}>
            <div className="export-changes-page">
              {shown.map((passage, index) => (
                <p key={`${passage.line}:${index}`}>
                  <MarkedPassage passage={passage} keepDeleted={options.keepDeleted} />
                </p>
              ))}
            </div>
            <span className="export-changes-caption">{t`The first changes, marked this way`}</span>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}

/** A citation as the page would number it, rather than its source. */
const CITATION = /~?\\(?:cite[a-zA-Z]*|parencite|textcite|autocite)\*?(?:\[[^\]]*\])*\{[^}]*\}/g;

/** A passage as latexdiff marks it: deleted words struck (or gone), new ones underlined with a wave. */
function MarkedPassage(props: { passage: ProsePassage; keepDeleted: boolean }) {
  return <>{markedParts(props.passage, props.keepDeleted)}</>;
}

/** Its marks as nodes: outside the component, as the compiler cannot compile `++cited` in a lambda. */
function markedParts({ text, edits }: ProsePassage, keepDeleted: boolean): ReactNode[] {
  let cited = 0;
  const flat = (part: string) => part.replace(CITATION, () => ` [${++cited}]`).replace(/\s+/g, " ");
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const { edit, from, to, deleted, inserted } of inlineEditSpans(text, edits)) {
    parts.push(flat(text.slice(cursor, from)));
    const struck = Boolean(deleted.trim() && keepDeleted);
    if (struck) parts.push(<del key={`d${edit.id}`}>{flat(deleted).trim()}</del>);
    if (struck && inserted.trim()) parts.push(" ");
    if (inserted.trim()) parts.push(<ins key={`i${edit.id}`}>{flat(inserted).trim()}</ins>);
    // The spaces at the change's edges stay outside the marks.
    if (/\s$/.test(inserted || deleted)) parts.push(" ");
    cursor = to;
  }
  parts.push(flat(text.slice(cursor)));
  return parts;
}
