/**
 * Terms: the names and spellings the paper settles on, and the English it is
 * written in, with every place across its .tex files that writes a term
 * another way. Each place is changed or kept by the writer, one at a time
 * or a rule's at once; a kept place is remembered by the words around it and
 * stays kept. Nothing changes the paper by itself: changing the English
 * only changes what spell checking marks, and a new rule only lists places.
 *
 * The rules live in the manifest (src-tauri/src/project/terms.rs), so
 * Proofread and Polish read the same ones (`termGuidance`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowRight, BookA, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { EnglishVariant, TermRule } from "../app-types";
import { toMessage } from "../app-utils";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { IconButton } from "../components/ui/icon-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { PanelHeader } from "../components/ui/panel-header";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useLatestRef } from "../hooks/use-latest-ref";
import { applyTermHits, checkTerms, type TermHit, type TermSource } from "./term-check";
import "./terms-panel.css";

export type TermFileChange = { path: string; before: string; after: string };

type Sources =
  | { phase: "loading" }
  | { phase: "failed"; error: string }
  | { phase: "ready"; sources: TermSource[] };

/* eslint-disable lingui/no-unlocalized-strings -- an English term, the same example in every language */
const EXAMPLE_TERM = "zero-shot";
const EXAMPLE_VARIANTS = "zero shot, zeroshot";
/* eslint-enable lingui/no-unlocalized-strings */

/** Places a rule lists before "Show more": a long paper can hold thousands. */
const SHOWN_PLACES = 20;

/** The Select's value for an unset variant; never stored. */
const UNSET = "unset";

const splitForms = (text: string) => text.split(/[,，、;；\n]/).map((form) => form.trim()).filter(Boolean);
const sameForm = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

function RuleForm(props: {
  rule: TermRule | null;
  /** The other rules, whose forms a new term may not take. */
  others: readonly TermRule[];
  onSave: (rule: TermRule) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [term, setTerm] = useState(props.rule?.term ?? "");
  const [variants, setVariants] = useState(props.rule?.variants.join(", ") ?? "");
  const [note, setNote] = useState(props.rule?.note ?? "");
  const [tried, setTried] = useState(false);
  const trimmed = term.trim();
  const clash = props.others.find((other) => [other.term, ...other.variants].some((form) => sameForm(form, trimmed)));
  const error = !trimmed
    ? t`Enter the term the paper should use.`
    : clash ? t`The rule for “${clash.term}” already covers “${trimmed}”.` : null;
  const save = () => {
    setTried(true);
    if (error) return;
    props.onSave({
      term: trimmed,
      variants: splitForms(variants).filter((form) => !sameForm(form, trimmed)),
      note: note.trim(),
      // Editing a rule's words keeps the places already kept.
      skipped: props.rule?.skipped ?? [],
    });
  };
  return (
    <form
      className="terms-rule-form"
      aria-label={props.rule ? t`Edit rule` : t`New rule`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <label>
        <span><Trans>Write as</Trans></span>
        <Input autoFocus value={term} placeholder={EXAMPLE_TERM} onChange={(event) => setTerm(event.target.value)} aria-invalid={tried && !!error} />
      </label>
      <label>
        <span><Trans>Instead of</Trans></span>
        <Input value={variants} placeholder={EXAMPLE_VARIANTS} onChange={(event) => setVariants(event.target.value)} />
        <small><Trans>Separate forms with commas. Other capitalizations are found without listing them.</Trans></small>
      </label>
      <label>
        <span><Trans>Why <small>(optional)</small></Trans></span>
        <Input value={note} placeholder={t`Hyphenated when it modifies a noun`} onChange={(event) => setNote(event.target.value)} />
      </label>
      {tried && error && <InlineMessage level="error">{error}</InlineMessage>}
      <div className="terms-rule-form-actions">
        <Button variant="ghost" size="compact" onClick={props.onCancel}><Trans>Cancel</Trans></Button>
        <Button variant="primary" size="compact" type="submit"><Trans>Save rule</Trans></Button>
      </div>
    </form>
  );
}

function HitRow(props: {
  hit: TermHit;
  busy: boolean;
  onOpen: () => void;
  onChange?: () => void;
  onKeep?: () => void;
  onRestore?: () => void;
}) {
  const { hit } = props;
  return (
    <li className="terms-hit">
      <button type="button" className="terms-hit-place" onClick={props.onOpen}>
        <span className="terms-hit-path">{hit.path}</span>
        <span className="terms-hit-line-number">{hit.line}</span>
      </button>
      {/* The source line as written, the form struck and the term after it:
          only those words, where a word diff would take in the command or
          brace glued to them. */}
      <p className="terms-hit-text" data-kept={props.onRestore ? "" : undefined}>
        {hit.before}
        <del>{hit.text.replace(/\s+/g, " ")}</del>
        {props.onRestore ? null : <>{" "}<ins>{hit.replacement}</ins></>}
        {hit.after}
      </p>
      <div className="terms-hit-actions">
        {props.onRestore ? (
          <Button size="compact" variant="ghost" disabled={props.busy} onClick={props.onRestore}><Trans>Check again</Trans></Button>
        ) : (
          <>
            <Button size="compact" variant="ghost" disabled={props.busy} onClick={props.onKeep}>
              <Trans>Keep</Trans>
            </Button>
            <Button size="compact" variant="tinted" disabled={props.busy} onClick={props.onChange}>
              <Trans context="term">Change</Trans>
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function TermsPanel(props: {
  rules: readonly TermRule[];
  englishVariant: EnglishVariant | null;
  /** The project's .tex files as on disk, after the open editor's edits are saved. */
  readSources: () => Promise<TermSource[]>;
  /** Store the rules and English; false when that failed. */
  onSaveTerms: (rules: TermRule[], englishVariant: EnglishVariant | null) => Promise<boolean>;
  /** Write the confirmed changes as one history entry; false when nothing was written. */
  onApply: (label: string, files: TermFileChange[]) => Promise<boolean>;
  onOpen: (path: string, line: number) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  // What the writer last chose, shown while its write is under way: a second
  // Keep before the first is stored builds on the first instead of the
  // manifest that does not have it yet. The manifest that answers replaces
  // the rules, which retires the draft.
  const [draft, setDraft] = useState<{ base: readonly TermRule[]; rules: TermRule[]; englishVariant: EnglishVariant | null } | null>(null);
  const current = draft?.base === props.rules ? draft : null;
  const rules = current?.rules ?? props.rules;
  const englishVariant = current ? current.englishVariant : props.englishVariant;
  const save = (next: TermRule[], variant: EnglishVariant | null) => {
    const mine = { base: props.rules, rules: next, englishVariant: variant };
    setDraft(mine);
    void props.onSaveTerms(next, variant).then((saved) => {
      if (!saved) setDraft((latest) => latest === mine ? null : latest);
    });
  };
  const [sources, setSources] = useState<Sources>({ phase: "loading" });
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [showKept, setShowKept] = useState(false);
  /** Terms whose every place is listed. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const readRef = useRef(0);
  const readSourcesRef = useLatestRef(props.readSources);

  const read = useCallback(() => {
    // The list stays up while the files are read again; the newest read lands.
    const generation = ++readRef.current;
    readSourcesRef.current().then(
      (next) => { if (generation === readRef.current) setSources({ phase: "ready", sources: next }); },
      (reason: unknown) => { if (generation === readRef.current) setSources({ phase: "failed", error: toMessage(reason) }); },
    );
  }, [readSourcesRef]);
  useEffect(() => {
    read();
    return () => { readRef.current += 1; };
  }, [read]);

  const loaded = sources.phase === "ready" ? sources.sources : null;
  const reports = useMemo(() => loaded ? checkTerms(loaded, rules) : [], [loaded, rules]);
  const pending = reports.flatMap((report) => report.hits.filter((hit) => !hit.skipped));
  const kept = reports.flatMap((report) => report.hits.filter((hit) => hit.skipped));
  const leftAsWritten = reports.reduce((sum, report) => sum + report.kept, 0);
  const pendingFiles = new Set(pending.map((hit) => hit.path)).size;

  const variantLabels: Record<EnglishVariant | typeof UNSET, string> = {
    [UNSET]: t`As the text has it`,
    american: t`American`,
    british: t`British`,
    canadian: t`Canadian`,
    australian: t`Australian`,
  };

  const saveRules = (next: TermRule[]) => save(next, englishVariant);
  const updateRule = (term: string, update: (rule: TermRule) => TermRule) => {
    saveRules(rules.map((rule) => rule.term === term ? update(rule) : rule));
  };
  const keep = (hit: TermHit) => updateRule(hit.term, (rule) => ({
    ...rule,
    skipped: [...(rule.skipped ?? []), { path: hit.path, context: hit.context }],
  }));
  const restore = (hit: TermHit) => updateRule(hit.term, (rule) => ({
    ...rule,
    skipped: (rule.skipped ?? []).filter((skip) => skip.path !== hit.path || skip.context !== hit.context),
  }));
  const change = async (hits: TermHit[]) => {
    if (!loaded || !hits.length || busy) return;
    const terms = [...new Set(hits.map((hit) => hit.replacement))];
    // eslint-disable-next-line lingui/no-unlocalized-strings -- a history entry's label, written in English like every other
    const label = terms.length === 1 ? `Use “${terms[0]}”` : "Apply project terms";
    setBusy(true);
    const applied = await props.onApply(label, applyTermHits(loaded, hits)).catch(() => false);
    setBusy(false);
    if (applied) read();
  };

  const summary = loaded == null
    ? null
    : pending.length
      ? pendingFiles === 1
        ? pending.length === 1 ? t`1 place to review in 1 file` : t`${pending.length} places to review in 1 file`
        : t`${pending.length} places to review in ${pendingFiles} files`
      : rules.length
        ? loaded.length === 1 ? t`Every rule is followed in the 1 .tex file` : t`Every rule is followed across ${loaded.length} .tex files`
        : null;

  return (
    <ResizableDrawer className="terms-drawer" onClose={props.onClose}>
      <PanelHeader className="drawer-header" icon={<BookA size={16} />} title={t`Terms`} onClose={props.onClose} />
      <p className="drawer-copy">
        <Trans>The names and spellings this paper settles on. Proofread and Polish follow them as well.</Trans>
      </p>

      <section className="terms-section terms-english" aria-labelledby="terms-english-label">
        <div className="terms-english-row">
          <span id="terms-english-label" className="terms-section-title"><Trans>English</Trans></span>
          <Select
            value={englishVariant ?? UNSET}
            onValueChange={(value) => save([...rules], value === UNSET ? null : value as EnglishVariant)}
          >
            <SelectTrigger className="terms-english-select" aria-labelledby="terms-english-label"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="end">
              {Object.entries(variantLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <small className="terms-caption">
          {englishVariant
            ? <Trans>Spell checking marks the other variants’ spellings. Nothing in the text is changed for you.</Trans>
            : <Trans>Spell checking uses American spelling, and Proofread keeps the spelling the text already uses.</Trans>}
        </small>
      </section>

      <section className="terms-section" aria-labelledby="terms-rules-title">
        <header className="terms-section-head">
          <h3 id="terms-rules-title" className="terms-section-title">
            <Trans>Rules</Trans>
            {rules.length > 0 && <span className="terms-count">{rules.length}</span>}
          </h3>
          {editing !== "new" && (
            <Button size="compact" variant="ghost" onClick={() => setEditing("new")}>
              <Plus size={14} aria-hidden /><Trans>Add rule</Trans>
            </Button>
          )}
        </header>
        {editing === "new" && (
          <RuleForm
            rule={null}
            others={rules}
            onCancel={() => setEditing(null)}
            onSave={(rule) => {
              saveRules([...rules, rule]);
              setEditing(null);
            }}
          />
        )}
        {rules.length === 0 && editing !== "new" ? (
          <EmptyState
            className="terms-empty"
            density="compact"
            title={t`No rules yet`}
            description={t`Add a name the paper should always write one way, such as zero-shot or ResNet, and the forms to look for.`}
          />
        ) : (
          <ul className="terms-rules">
            {rules.map((rule, index) => editing === index ? (
              <li key={rule.term}>
                <RuleForm
                  rule={rule}
                  others={rules.filter((_, other) => other !== index)}
                  onCancel={() => setEditing(null)}
                  onSave={(next) => {
                    saveRules(rules.map((existing, other) => other === index ? next : existing));
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li key={rule.term} className="terms-rule">
                <div className="terms-rule-forms">
                  {rule.variants.length > 0 && (
                    <>
                      <span className="terms-rule-variants">{rule.variants.join(", ")}</span>
                      <ArrowRight size={13} aria-hidden />
                      <span className="sr-only">{t`becomes`}</span>
                    </>
                  )}
                  <strong>{rule.term}</strong>
                </div>
                {rule.note && <p className="terms-rule-note">{rule.note}</p>}
                <div className="terms-rule-actions">
                  <IconButton size="compact" label={t`Edit rule for ${rule.term}`} onClick={() => setEditing(index)}>
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton size="compact" label={t`Remove rule for ${rule.term}`} onClick={() => saveRules(rules.filter((_, other) => other !== index))}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {rules.length > 0 && (
        <section className="terms-section" aria-labelledby="terms-review-title" aria-busy={sources.phase === "loading" || busy}>
          <header className="terms-section-head">
            <h3 id="terms-review-title" className="terms-section-title"><Trans>In the paper</Trans></h3>
            <IconButton size="compact" label={t`Check again`} disabled={sources.phase === "loading" || busy} onClick={read}>
              <RefreshCw size={13} />
            </IconButton>
          </header>
          {sources.phase === "loading" && (
            <p className="terms-status"><InfinityLoader size={14} /><Trans>Reading the paper’s .tex files…</Trans></p>
          )}
          {sources.phase === "failed" && <InlineMessage level="error">{sources.error}</InlineMessage>}
          {summary && <p className="terms-summary" aria-live="polite">{summary}</p>}
          {loaded && leftAsWritten > 0 && (
            <small className="terms-caption">
              {leftAsWritten === 1
                ? t`1 more is in math, a comment, a key or a path, and stays as written.`
                : t`${leftAsWritten} more are in math, comments, keys or paths, and stay as written.`}
            </small>
          )}
          {reports.map((report) => {
            const hits = report.hits.filter((hit) => !hit.skipped);
            if (!hits.length) return null;
            return (
              <div key={report.rule.term} className="terms-group">
                <header className="terms-group-head">
                  <strong>{report.rule.term}</strong>
                  <Button size="compact" variant="tinted" disabled={busy} onClick={() => void change(hits)}>
                    {hits.length === 1 ? t`Change 1` : t`Change all ${hits.length}`}
                  </Button>
                </header>
                {report.rule.note && <p className="terms-rule-note">{report.rule.note}</p>}
                <ul className="terms-hits">
                  {(expanded.has(report.rule.term) ? hits : hits.slice(0, SHOWN_PLACES)).map((hit) => (
                    <HitRow
                      key={`${hit.path}:${hit.from}`}
                      hit={hit}
                      busy={busy}
                      onOpen={() => props.onOpen(hit.path, hit.line)}
                      onChange={() => void change([hit])}
                      onKeep={() => keep(hit)}
                    />
                  ))}
                </ul>
                {hits.length > SHOWN_PLACES && !expanded.has(report.rule.term) && (
                  <Button
                    className="terms-more"
                    size="compact"
                    variant="ghost"
                    onClick={() => setExpanded((terms) => new Set([...terms, report.rule.term]))}
                  >
                    {t`Show ${hits.length - SHOWN_PLACES} more`}
                  </Button>
                )}
              </div>
            );
          })}
          {kept.length > 0 && (
            <div className="terms-kept">
              <Button size="compact" variant="ghost" aria-expanded={showKept} onClick={() => setShowKept((open) => !open)}>
                {kept.length === 1 ? t`1 place kept as written` : t`${kept.length} places kept as written`}
              </Button>
              {showKept && (
                <ul className="terms-hits">
                  {kept.map((hit) => (
                    <HitRow
                      key={`${hit.term}:${hit.path}:${hit.from}`}
                      hit={hit}
                      busy={busy}
                      onOpen={() => props.onOpen(hit.path, hit.line)}
                      onRestore={() => restore(hit)}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}
    </ResizableDrawer>
  );
}
