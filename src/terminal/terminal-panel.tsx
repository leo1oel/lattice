/**
 * The Terminal panel's content: the terminal tabs (once there are two), the
 * screen of the one in front, its find field, and how a shell that stopped
 * by itself ended. Loaded when the panel first opens (terminal-view.tsx).
 *
 * Screens outlive this component: each lives in its session (see
 * terminal-sessions.ts) and is only moved into a slot here, so the panel
 * unmounting and mounting again (a workspace without it, then one with it)
 * keeps every shell and its scrollback.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { isBrowserHosted } from "../platform/browser-runtime";
import type { TrellisController } from "../trellis/trellis-controller";
import type { TerminalSession } from "./terminal-sessions";
import type { XtermScreen } from "./terminal-screen";
import { terminalFontFamily, terminalTheme } from "./terminal-theme";
import { closeTerminal, findRequests, followProject, openTerminal, terminals } from "./terminal-window";
import { TERMINAL_ICON } from "./terminal-icon";
import "./terminal.css";

/** What re-themes the terminal: the root's appearance attributes (use-appearance.ts). */
const APPEARANCE_ATTRIBUTES = ["data-theme", "data-tint", "data-accent", "data-code-theme", "data-code-theme-kind", "style"];

type Session = TerminalSession<XtermScreen>;

/** Hand every screen the colours and font the panel's cascade resolves to, now and on each appearance change. */
function useAppearance(panel: RefObject<HTMLDivElement | null>, sessions: readonly Session[]) {
  const themed = useRef(new WeakSet<XtermScreen>());
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      themed.current = new WeakSet();
      setRevision((value) => value + 1);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const pending = sessions.filter(({ screen }) => !themed.current.has(screen));
    if (!pending.length) return;
    const appearance = {
      theme: terminalTheme(element),
      fontFamily: terminalFontFamily(element),
      fontSize: Number.parseFloat(getComputedStyle(element).getPropertyValue("--terminal-font-size")) || 12,
    };
    for (const { screen } of pending) {
      screen.setAppearance(appearance);
      themed.current.add(screen);
    }
  }, [panel, sessions, revision]);
}

/**
 * The slot a session's screen stands in: shown only for the tab in front.
 * While a panel is dragged (`moving`) the grid keeps its size: Trellis shrinks
 * the panel being dragged to a strip a row high, and a grid fitted to that
 * pushes all but the cursor's line into the scrollback, where the shell's
 * redraw cannot reach, so its prompt came back twice after the drop.
 */
function ScreenSlot({ session, shown, focused, moving }: { session: Session; shown: boolean; focused: boolean; moving: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { screen } = session;
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    screen.attach(slot);
    return () => {
      if (screen.element.parentElement === slot) slot.removeChild(screen.element);
    };
  }, [screen]);
  useLayoutEffect(() => {
    screen.setShown(shown);
    if (!shown || moving) return;
    screen.fit();
    const slot = ref.current;
    if (!slot) return;
    // Every change of the slot's size (the divider dragged, the window
    // resized) refits the grid, once per frame.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => screen.fit());
    });
    observer.observe(slot);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [screen, shown, moving]);
  useEffect(() => {
    if (shown && focused) screen.focus();
  }, [screen, shown, focused]);
  return <div ref={ref} className="terminal-slot" hidden={!shown} />;
}

function TerminalTab({ session, selected, label }: { session: Session; selected: boolean; label: string }) {
  const { t } = useLingui();
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);
  const finish = (commit: boolean) => {
    if (commit && inputRef.current) terminals.rename(session.key, inputRef.current.value);
    setRenaming(false);
    session.screen.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div className="terminal-tab" data-selected={selected || undefined} title={renaming ? undefined : t`Double-click to rename`}>
      {renaming ? (
        <input
          ref={inputRef}
          className="terminal-tab-rename"
          defaultValue={label}
          aria-label={t`Terminal name`}
          maxLength={40}
          onKeyDown={onKeyDown}
          onBlur={() => finish(true)}
        />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={selected}
          className="terminal-tab-label"
          onClick={() => {
            terminals.select(session.key);
            session.screen.focus();
          }}
          onDoubleClick={() => setRenaming(true)}
          data-terminal-key={session.key}
          tabIndex={selected ? 0 : -1}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              setRenaming(true);
              return;
            }
            // The tab list's arrow keys, as every tab list's.
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const { sessions } = terminals.get();
            const index = sessions.findIndex(({ key }) => key === session.key) + (event.key === "ArrowRight" ? 1 : -1);
            const next = sessions[(index + sessions.length) % sessions.length];
            terminals.select(next.key);
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-terminal-key="${next.key}"]`)?.focus());
          }}
        >
          {label}
        </button>
      )}
      <IconButton size="compact" label={t`Close ${label}`} tooltip={false} onClick={() => void closeTerminal(session.key)}>
        <X size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function FindField({ screen, onClose }: { screen: XtermScreen; onClose: () => void }) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    screen.onFindResults(setResults);
    inputRef.current?.focus();
    return () => {
      screen.onFindResults(null);
      screen.clearFind();
    };
  }, [screen]);
  const close = () => {
    onClose();
    screen.focus();
  };
  const step = (direction: "next" | "previous") => screen.find(query, direction, { incremental: false });
  const count = !query || !results ? "" : results.count === 0 ? t`No results` : results.index < 0 ? `${results.count}+` : `${results.index + 1}/${results.count}`;
  return (
    <div className="terminal-find" role="search">
      <Input
        ref={inputRef}
        controlSize="compact"
        value={query}
        placeholder={t`Find in terminal`}
        aria-label={t`Find in terminal`}
        onChange={(event) => {
          setQuery(event.target.value);
          screen.find(event.target.value, "next", { incremental: true });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") step(event.shiftKey ? "previous" : "next");
          else if (event.key === "Escape") close();
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      <span className="terminal-find-count" aria-live="polite">{count}</span>
      <IconButton size="compact" label={t`Previous match`} disabled={!query} onClick={() => step("previous")}><ChevronUp size={14} aria-hidden="true" /></IconButton>
      <IconButton size="compact" label={t`Next match`} disabled={!query} onClick={() => step("next")}><ChevronDown size={14} aria-hidden="true" /></IconButton>
      <IconButton size="compact" label={t`Close find`} onClick={close}><X size={14} aria-hidden="true" /></IconButton>
    </div>
  );
}

export function TerminalPanel({ controller, shown, focused, moving }: { controller: TrellisController; shown: boolean; focused: boolean; moving: boolean }) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const { sessions, active } = useSyncExternalStore(terminals.subscribe, terminals.get);
  const root = useSyncExternalStore(controller.app.subscribe, () => controller.app.get().projectRoot);
  // The terminal whose find field is open (⌘F, or the panel menu's Find).
  const [findingIn, setFindingIn] = useState<number | null>(null);
  useAppearance(panelRef, sessions);
  useEffect(() => followProject(controller), [controller]);
  // Opening the panel opens a terminal: there is nothing else to do in it.
  // A panel whose last tab was closed waits for the writer instead.
  // A browser tab never gets a shell (see src-tauri/src/terminal/caller.rs).
  const hosted = isBrowserHosted();
  useEffect(() => {
    if (root && !hosted && !terminals.get().sessions.length) openTerminal();
  }, [root, hosted]);
  const current = sessions.find((session) => session.key === active) ?? null;
  const finding = current !== null && findingIn === current.key;
  useEffect(() => {
    const request = () => setFindingIn(terminals.get().active);
    findRequests.add(request);
    for (const session of sessions) session.screen.onFindRequest(request);
    return () => { findRequests.delete(request); };
  }, [sessions]);
  const label = ({ name, number }: Session) => name ?? t`Terminal ${number}`;
  if (hosted) {
    return (
      <div ref={panelRef} className="terminal-panel">
        <EmptyState
          fill
          density="compact"
          icon={TERMINAL_ICON}
          title={t`The terminal is in the Lattice window`}
          description={t`A browser tab cannot run commands on this Mac`}
        />
      </div>
    );
  }
  const state = current?.state;
  const code = state?.kind === "exited" ? state.code : null;
  const message = state?.kind === "failed" ? state.message : "";
  return (
    <div ref={panelRef} className="terminal-panel">
      {sessions.length > 1 && (
        <div className="terminal-tabs" role="tablist" aria-label={t`Terminals`}>
          {sessions.map((session) => (
            <TerminalTab key={session.key} session={session} selected={session.key === active} label={label(session)} />
          ))}
        </div>
      )}
      <div className="terminal-stage">
        {sessions.map((session) => (
          <ScreenSlot key={session.key} session={session} shown={shown && session.key === active} focused={focused && !finding} moving={moving} />
        ))}
        {finding && <FindField screen={current.screen} onClose={() => setFindingIn(null)} />}
        {!sessions.length && (
          <EmptyState
            fill
            density="compact"
            icon={TERMINAL_ICON}
            title={t`No terminal open`}
            description={t`Run latexmk, git or any command in this project’s folder`}
            actions={<Button size="compact" variant="tinted" onClick={openTerminal}>{t`New terminal`}</Button>}
          />
        )}
      </div>
      {state?.kind === "exited" && (
        <div className="terminal-ended" role="status">
          <span>{code === null ? t`The shell was stopped` : t`The shell exited with code ${code}`}</span>
          <Button size="compact" variant="secondary" onClick={() => current && terminals.close(current.key)}>{t`Close`}</Button>
        </div>
      )}
      {state?.kind === "failed" && (
        <div className="terminal-ended" role="alert">
          <span>{t`The shell did not start: ${message}`}</span>
          <Button
            size="compact"
            variant="secondary"
            onClick={() => {
              if (current) terminals.close(current.key);
              openTerminal();
            }}
          >
            {t`Try again`}
          </Button>
        </div>
      )}
    </div>
  );
}
