/**
 * A plugin command in the palette (command-palette.tsx), once chosen: its
 * input step, the run with its latest progress, and the result drawn
 * natively (items, diagnostics, a message) or the error. The palette stays
 * open throughout; Escape steps back from the input, cancels a run, and
 * closes a result. GPUI draws the same steps (gpui/docs/).
 *
 * Actions close the palette and run through the app's own paths
 * (`PluginRunHost.perform`), except the bibliography writes, which first
 * show the entry or the change here and write only once the writer confirms.
 */
import { useEffect, useMemo, useReducer, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { CircleAlert, CircleX, Info, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../components/ui/modal-dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { InlineMessage } from "../components/ui/inline-message";
import { InfinityLoader } from "../components/ui/activity-icons";
import { EmptyState } from "../components/ui/empty-state";
import { hostErrorMessage } from "../app-utils";
import { useLatestRef } from "../hooks/use-latest-ref";
import {
  asPluginError, cancelPluginRun, runPluginCommand, type PluginAction, type PluginBibAction, type PluginCommand,
  type PluginDiagnostic, type PluginError, type PluginItem, type PluginPageContext, type PluginResult,
} from "./plugin-ipc";
import { actionLabel, pluginErrorOpensSettings, pluginErrorText } from "./plugin-text";
import { appendBibEntry, findBibEntry, replaceBibEntry } from "./plugin-bib";
import { PluginMarkdown } from "./plugin-markdown";
import "./plugins.css";

/** What a run needs from the app: where the writer is, and the app's own ways to act. */
export type PluginRunHost = {
  /** The window's project, which the run pins; null on the welcome screen. */
  projectRoot: string | null;
  /** Read when the run starts: the active file, the editor's selection and cursor. */
  context: () => PluginPageContext | null;
  locale: string;
  /** Run an action that writes nothing (cite, reveal, open, copy), once the palette has closed. */
  perform: (action: Exclude<PluginAction, PluginBibAction>) => void;
  bibliography: {
    /** The project's primary bibliography, where an entry goes when the plugin names no file. */
    primary: string | null;
    read: (path: string) => Promise<string>;
    /** The app's bibliography write: `change` maps the file as it is now to what to write. */
    rewrite: (path: string, change: (current: string) => string) => Promise<boolean>;
  };
  openSettings: () => void;
};

type Confirm = { action: PluginBibAction; file: string; before: string | null; busy: boolean; error: string | null };
type Step =
  | { kind: "input" }
  | { kind: "running"; runId: string; progress: string | null }
  | { kind: "result"; result: PluginResult; confirm: Confirm | null }
  | { kind: "error"; error: PluginError };

type RunState = { step: Step; text: string };
type RunAction =
  | { type: "type"; text: string }
  | { type: "run"; runId: string }
  | { type: "progress"; runId: string; message: string }
  | { type: "settled"; runId: string; step: Extract<Step, { kind: "result" | "error" }> }
  | { type: "confirm"; confirm: Confirm | null };

/** A run's progress and answer count only while it is the run under way: a cancelled one's late answer is dropped. */
function reduceRun(state: RunState, action: RunAction): RunState {
  const current = state.step.kind === "running" ? state.step.runId : null;
  switch (action.type) {
    case "type": return { ...state, text: action.text };
    case "run": return { ...state, step: { kind: "running", runId: action.runId, progress: null } };
    case "progress":
      return state.step.kind === "running" && current === action.runId ? { ...state, step: { ...state.step, progress: action.message } } : state;
    case "settled": return current === action.runId ? { ...state, step: action.step } : state;
    case "confirm": return state.step.kind === "result" ? { ...state, step: { ...state.step, confirm: action.confirm } } : state;
  }
}

const SEVERITY_GLYPHS = { error: CircleX, warning: TriangleAlert, info: Info } as const;

/** The highlighted row of a result list, moved by ↑↓ and the pointer. */
function useActiveRow(count: number) {
  const [active, setActive] = useReducer((current: number, to: number | "next" | "previous") => (
    to === "next" ? Math.min(current + 1, Math.max(0, count - 1)) : to === "previous" ? Math.max(0, current - 1) : to
  ), 0);
  const listRef = useRef<HTMLDivElement>(null);
  // The list takes the keys as it appears, so ↑↓, Return and Escape work at once.
  useEffect(() => listRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const keys = (event: KeyboardEvent, run: (index: number) => void) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(event.key === "ArrowDown" ? "next" : "previous");
    } else if (event.key === "Enter" && count > 0 && event.target === event.currentTarget) {
      event.preventDefault();
      run(Math.min(active, count - 1));
    }
  };
  return { active: Math.min(active, Math.max(0, count - 1)), setActive, listRef, keys };
}

function ActionButtons({ actions, onAct }: { actions: readonly PluginAction[]; onAct: (action: PluginAction) => void }) {
  return actions.map((action, index) => (
    <Button
      key={index}
      size="compact"
      variant="secondary"
      className="plugin-row-action"
      onClick={(event) => { event.stopPropagation(); onAct(action); }}
    >
      {actionLabel(action)}
    </Button>
  ));
}

function ItemsView({ items, onAct }: { items: readonly PluginItem[]; onAct: (action: PluginAction) => void }) {
  const { t } = useLingui();
  const { active, setActive, listRef, keys } = useActiveRow(items.length);
  if (!items.length) return <EmptyState density="compact" description={t`Nothing found`} />;
  const runFirst = (index: number) => {
    const first = items[index]?.actions[0];
    if (first) onAct(first);
  };
  return (
    <ScrollArea className="quick-open-scroll plugin-results-scroll" viewportRef={listRef}
      viewportProps={{ role: "listbox", tabIndex: 0, "aria-label": t`Results`, onKeyDown: (event) => keys(event, runFirst) }}
      contentClassName="plugin-results">
      {items.map((item, index) => (
        <div
          key={item.id}
          role="option"
          aria-selected={index === active}
          className="plugin-row"
          data-active={index === active || undefined}
          onMouseMove={() => { if (index !== active) setActive(index); }}
          onClick={() => runFirst(index)}
        >
          <div className="plugin-row-text">
            <span className="plugin-row-title">{item.title}</span>
            {item.subtitle && <span className="plugin-row-muted">{item.subtitle}</span>}
            {item.detail && <span className="plugin-row-muted">{item.detail}</span>}
          </div>
          {index === active && <ActionButtons actions={item.actions.slice(1)} onAct={onAct} />}
          {item.badges.map((badge) => <Badge key={badge} size="compact" className="plugin-badge">{badge}</Badge>)}
        </div>
      ))}
    </ScrollArea>
  );
}

function DiagnosticsView({ items, onAct }: { items: readonly PluginDiagnostic[]; onAct: (action: PluginAction) => void }) {
  const { t } = useLingui();
  // Grouped by file, each file where its first problem was; rows keep the
  // plugin's order within a file.
  const ordered = useMemo(() => {
    const byFile = new Map<string, PluginDiagnostic[]>();
    for (const item of items) byFile.set(item.file, [...(byFile.get(item.file) ?? []), item]);
    return [...byFile.values()].flat();
  }, [items]);
  const { active, setActive, listRef, keys } = useActiveRow(ordered.length);
  if (!items.length) return <EmptyState density="compact" description={t`No problems found`} />;
  const reveal = (index: number) => {
    const item = ordered[index];
    if (item) onAct({ type: "reveal", file: item.file, line: item.line });
  };
  return (
    <ScrollArea className="quick-open-scroll plugin-results-scroll" viewportRef={listRef}
      viewportProps={{ role: "listbox", tabIndex: 0, "aria-label": t`Problems`, onKeyDown: (event) => keys(event, reveal) }}
      contentClassName="plugin-results">
      {ordered.map((item, index) => {
        const Glyph = SEVERITY_GLYPHS[item.severity] ?? CircleAlert;
        const line = item.line;
        const severity = { error: t`Error`, warning: t`Warning`, info: t`Info` }[item.severity];
        return (
          <div key={item.id} className="plugin-diagnostic-group">
            {(index === 0 || ordered[index - 1].file !== item.file) && (
              <div className="picker-section plugin-file-header" aria-hidden="true">{item.file}</div>
            )}
            <div
              role="option"
              aria-selected={index === active}
              className="plugin-row"
              data-active={index === active || undefined}
              onMouseMove={() => { if (index !== active) setActive(index); }}
              onClick={() => reveal(index)}
            >
              <span className="plugin-severity" data-severity={item.severity} role="img" aria-label={severity}>
                <Glyph size={14} aria-hidden="true" />
              </span>
              <div className="plugin-row-text">
                <span className="plugin-row-title">{item.message}</span>
                <span className="plugin-row-muted">
                  {[line ? t`line ${line}` : null, item.code].filter(Boolean).join(" · ")}
                </span>
              </div>
              {index === active && <ActionButtons actions={item.fixes} onAct={onAct} />}
            </div>
          </div>
        );
      })}
    </ScrollArea>
  );
}

function MessageView({ markdown, onOpenUrl }: { markdown: string; onOpenUrl: (url: string) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => viewportRef.current?.focus({ preventScroll: true }), []);
  return (
    <ScrollArea className="plugin-message-scroll" viewportRef={viewportRef} viewportProps={{ tabIndex: 0 }}>
      <PluginMarkdown markdown={markdown} onOpenUrl={onOpenUrl} />
    </ScrollArea>
  );
}

function ConfirmView({ confirm, onCancel, onConfirm }: { confirm: Confirm; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useLingui();
  const { action, file, before } = confirm;
  const replacing = action.type === "replaceBibEntry";
  const key = replacing ? action.key : "";
  return (
    <div className="plugin-confirm">
      <h2>{replacing ? t`Update “${key}” in ${file}?` : t`Add this entry to ${file}?`}</h2>
      <ScrollArea className="plugin-confirm-scroll">
        {replacing && before !== null ? (
          <div className="plugin-bib-diff">
            <span className="plugin-bib-label">{t`Now`}</span>
            <pre className="plugin-bib-entry" data-change="removed">{before}</pre>
            <span className="plugin-bib-label">{t`After`}</span>
            <pre className="plugin-bib-entry" data-change="added">{action.bibtex.trim()}</pre>
          </div>
        ) : !replacing && <pre className="plugin-bib-entry">{action.bibtex.trim()}</pre>}
      </ScrollArea>
      {confirm.error && <InlineMessage level="error">{confirm.error}</InlineMessage>}
      <div className="modal-actions">
        <Button variant="ghost" onClick={onCancel} disabled={confirm.busy}>{t`Cancel`}</Button>
        <Button variant="primary" autoFocus onClick={onConfirm} disabled={confirm.busy || (replacing && before === null)}>
          {replacing ? t`Update entry` : t`Add entry`}
        </Button>
      </div>
    </div>
  );
}

export default function PluginRun({ command, host, returnFocus, onBack, onClose }: {
  command: PluginCommand;
  host: PluginRunHost;
  /** What had focus before the palette opened. */
  returnFocus: HTMLElement | null;
  /** Escape from the input step: back to the palette's list. */
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const takesInput = command.input.kind === "text";
  const [{ step, text }, dispatch] = useReducer(reduceRun, null, (): RunState => ({
    step: takesInput ? { kind: "input" } : { kind: "running", runId: crypto.randomUUID(), progress: null },
    text: "",
  }));
  const runningRef = useRef<string | null>(null);
  const hostRef = useLatestRef(host);
  const textRef = useLatestRef(text);
  const runId = step.kind === "running" ? step.runId : null;
  // This dialog replaces the palette's list, whose dialog hands focus back to
  // the editor as it unmounts (in a microtask, then on Radix's zero-delay
  // timer). Two timers later, focus comes back here if it left.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let inner = 0;
    const outer = window.setTimeout(() => {
      inner = window.setTimeout(() => {
        const dialog = dialogRef.current;
        if (!dialog || dialog.contains(document.activeElement)) return;
        dialog.querySelector<HTMLElement>('input, [role="listbox"], [role="status"], [tabindex="0"], button')?.focus({ preventScroll: true });
      }, 0);
    }, 0);
    return () => {
      window.clearTimeout(outer);
      window.clearTimeout(inner);
    };
  }, []);
  // One run per running step, named so Escape (or closing the palette) can
  // cancel it; a superseded run's late answer is ignored.
  useEffect(() => {
    if (!runId) return;
    runningRef.current = runId;
    const current = hostRef.current;
    runPluginCommand({
      runId, command, input: takesInput ? textRef.current : null, projectRoot: current.projectRoot,
      context: current.projectRoot ? current.context() : null, locale: current.locale,
    }, (event) => {
      if (event.type === "progress") dispatch({ type: "progress", runId, message: event.message });
    }).then(
      (result) => dispatch({ type: "settled", runId, step: { kind: "result", result, confirm: null } }),
      (reason: unknown) => dispatch({ type: "settled", runId, step: { kind: "error", error: asPluginError(reason) } }),
    ).finally(() => { if (runningRef.current === runId) runningRef.current = null; });
    return () => {
      if (runningRef.current !== runId) return;
      runningRef.current = null;
      void cancelPluginRun(runId).catch(() => {});
    };
  }, [runId, command, takesInput, hostRef, textRef]);

  const act = (action: PluginAction) => {
    if (action.type !== "addBibEntry" && action.type !== "replaceBibEntry") {
      onClose();
      host.perform(action);
      return;
    }
    if (step.kind !== "result") return;
    const file = action.file ?? host.bibliography.primary;
    const show = (confirm: Confirm) => dispatch({ type: "confirm", confirm });
    if (!file) {
      show({ action, file: "", before: null, busy: false, error: t`This project has no bibliography to add to.` });
      return;
    }
    if (action.type === "addBibEntry") {
      show({ action, file, before: null, busy: false, error: null });
      return;
    }
    show({ action, file, before: null, busy: true, error: null });
    host.bibliography.read(file).then((source) => {
      const before = findBibEntry(source, action.key)?.text ?? null;
      const key = action.key;
      show({ action, file, before, busy: false, error: before === null ? t`There is no entry “${key}” in ${file}.` : null });
    }, (reason: unknown) => show({ action, file, before: null, busy: false, error: hostErrorMessage(reason) }));
  };

  const write = (confirm: Confirm) => {
    const { action, file } = confirm;
    dispatch({ type: "confirm", confirm: { ...confirm, busy: true, error: null } });
    const change = action.type === "addBibEntry"
      ? (current: string) => appendBibEntry(current, action.bibtex.trim())
      : (current: string) => replaceBibEntry(current, action.key, action.bibtex);
    host.bibliography.rewrite(file, change).then(onClose, (reason: unknown) => {
      dispatch({ type: "confirm", confirm: { ...confirm, busy: false, error: hostErrorMessage(reason) } });
    });
  };

  const header = (summary?: string) => (
    <div className="plugin-run-header">
      <span className="plugin-run-name">{command.pluginName}</span>
      <span className="plugin-run-separator" aria-hidden="true">·</span>
      <span className="plugin-run-summary">{summary?.trim() || command.title}</span>
    </div>
  );

  let body: ReactNode;
  if (step.kind === "input") {
    body = (
      <div className="quick-open-header plugin-input-header">
        <span className="plugin-chip">{command.pluginName}</span>
        <SearchField
          autoFocus
          showIcon={false}
          role="textbox"
          aria-label={command.title}
          placeholder={command.input.placeholder ?? command.title}
          value={text}
          onChange={(event) => dispatch({ type: "type", text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            dispatch({ type: "run", runId: crypto.randomUUID() });
          }}
        />
      </div>
    );
  } else if (step.kind === "running") {
    const title = command.title;
    body = (
      <div className="plugin-progress" role="status" tabIndex={-1} ref={(node) => node?.focus({ preventScroll: true })}>
        <InfinityLoader size={16} />
        <span>{step.progress?.trim() || t`Running ${title}…`}</span>
      </div>
    );
  } else if (step.kind === "error") {
    const { error } = step;
    body = (
      <>
        {header()}
        <div className="plugin-error">
          <InlineMessage level="error">{pluginErrorText(error)}</InlineMessage>
          {error.code === "crashed" && error.stderr?.trim() && <pre className="plugin-stderr">{error.stderr.trim()}</pre>}
          {pluginErrorOpensSettings(error) && (
            <Button size="compact" variant="secondary" autoFocus onClick={() => { onClose(); host.openSettings(); }}>
              {t`Open Settings`}
            </Button>
          )}
        </div>
      </>
    );
  } else if (step.confirm) {
    const confirm = step.confirm;
    const result = step.result;
    body = (
      <>
        {header(result.summary)}
        <ConfirmView confirm={confirm} onCancel={() => dispatch({ type: "confirm", confirm: null })} onConfirm={() => write(confirm)} />
      </>
    );
  } else {
    const { result } = step;
    body = (
      <>
        {header(result.summary)}
        {result.kind === "items" ? <ItemsView items={result.items} onAct={act} />
          : result.kind === "diagnostics" ? <DiagnosticsView items={result.items} onAct={act} />
          : result.kind === "message" ? <MessageView markdown={result.markdown} onOpenUrl={(url) => host.perform({ type: "openUrl", url })} /> : <p className="plugin-unknown-result">{(result as { summary?: string }).summary ?? ""}</p>}
      </>
    );
  }

  return (
    <ModalDialog
      label={t`Command palette`}
      onClose={onClose}
      returnFocus={returnFocus}
      onEscapeKeyDown={(event) => {
        if (step.kind === "input") {
          event.preventDefault();
          onBack();
        } else if (step.kind === "result" && step.confirm && !step.confirm.busy) {
          event.preventDefault();
          dispatch({ type: "confirm", confirm: null });
        }
      }}
    >
      <div ref={dialogRef} className="modal quick-open-modal command-palette-modal plugin-run" data-step={step.kind}>
        {body}
      </div>
    </ModalDialog>
  );
}
