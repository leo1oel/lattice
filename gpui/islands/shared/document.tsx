/**
 * The document protocol the sheet and board islands share with their owner
 * (`gpui/crates/lattice-gpui/src/structured.rs`). The owner keeps the file's
 * text in its editor buffer and saves it as every other document is saved
 * (lattice-core's editor transaction, merged against the text it grew from);
 * the page is the editor in front of that text, as the Tauri app's canvas
 * hands `source` and `onChange` to the same components.
 *
 * Host to page:
 *   doc:open    { path, source, viewState, locale, active }   on every ready
 *   doc:source  { source }                                    a change on disk
 *   doc:active  { active }                                    shown or hidden
 *   doc:flush                                                 write pending edits now, then say so
 *   doc:locale  { locale }
 * Page to host:
 *   doc:change      { source }        the editor's serialized text
 *   doc:view-state  { viewState }     per-reader view state, never in the file
 *   doc:drawn                         the first frame is up: reveal the page
 *   doc:flushed                       after a doc:flush, once its doc:change (if any) is sent
 *   doc:persist     (request)         save now (`onPersist`); answers whether it did
 */
import { Fragment, useEffect, useReducer, type ReactNode } from "react";
import { host, type DocumentOpen } from "./host";
import { activateLocale } from "./boot";

export type DocumentHandle<ViewState> = {
  path: string;
  source: string;
  active: boolean;
  initialViewState?: ViewState;
  onChange: (next: string) => void;
  onViewState: (state: ViewState) => void;
  onPersist: () => Promise<boolean>;
  onFlushPendingChange: (flush: (() => boolean) | null) => void;
};

// A page holds one document, so what the editor registers and what the
// page last sent live with the page, outside React's state.
let pendingFlush: (() => boolean) | null = null;
/** The text this page last sent or was sent, so an echo is not a change. */
let sent: string | null = null;

const onChange = (next: string) => {
  sent = next;
  host().post("doc:change", { source: next });
};
const onViewState = (viewState: unknown) => host().post("doc:view-state", { viewState });
const onPersist = () => host().request<boolean>("doc:persist").catch(() => false);
const onFlushPendingChange = (flush: (() => boolean) | null) => { pendingFlush = flush; };

type State<ViewState> = {
  opened: DocumentOpen<ViewState> | null;
  source: string;
  active: boolean;
  localeReady: boolean;
};

type Action<ViewState> =
  | { type: "open"; open: DocumentOpen<ViewState> }
  | { type: "source"; source: string }
  | { type: "active"; active: boolean }
  | { type: "locale-ready" };

/** How long after its commit the editor is taken to have drawn. */
const DRAWN_DELAY_MS = 120;

function reduce<ViewState>(state: State<ViewState>, action: Action<ViewState>): State<ViewState> {
  switch (action.type) {
    case "open":
      return { ...state, opened: action.open, source: action.open.source, active: action.open.active };
    case "source":
      return { ...state, source: action.source };
    case "active":
      return { ...state, active: action.active };
    case "locale-ready":
      return { ...state, localeReady: true };
  }
}

/**
 * Hold the document the host opened here, and render `editor` once its
 * language is loaded. The editor is keyed by path, as the canvas keys it, so
 * another file opened in a woken page starts fresh.
 */
export function DocumentIsland<ViewState>({ editor }: { editor: (document: DocumentHandle<ViewState>) => ReactNode }) {
  const [state, dispatch] = useReducer(reduce<ViewState>, { opened: null, source: "", active: true, localeReady: false });
  const { opened, source, active, localeReady } = state;

  useEffect(() => {
    const bridge = host();
    const stops = [
      bridge.on("doc:open", (payload) => {
        const open = payload as DocumentOpen<ViewState>;
        sent = open.source;
        dispatch({ type: "open", open });
        void activateLocale(open.locale).then(() => dispatch({ type: "locale-ready" }));
      }),
      bridge.on("doc:source", (payload) => {
        const next = (payload as { source: string }).source;
        if (next === sent) return;
        sent = next;
        dispatch({ type: "source", source: next });
      }),
      bridge.on("doc:active", (payload) => dispatch({ type: "active", active: Boolean((payload as { active: boolean }).active) })),
      // The editor's flush calls onChange at once, so its doc:change goes
      // first: the host saves once it has this.
      bridge.on("doc:flush", () => {
        pendingFlush?.();
        bridge.post("doc:flushed");
      }),
      bridge.on("doc:locale", (payload) => { void activateLocale((payload as { locale: "en" | "zh-CN" }).locale); }),
    ];
    bridge.ready();
    return () => { for (const stop of stops) stop(); };
  }, []);

  useEffect(() => {
    if (!opened || !localeReady) return;
    // A timer, not animation frames: WebKit runs no frames for a page still
    // clipped away, and the host reveals it only on this. The editor has
    // committed by now; its own first layout follows within the delay.
    const timer = window.setTimeout(() => host().post("doc:drawn"), DRAWN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [opened, localeReady]);

  if (!opened || !localeReady) return null;
  const handle: DocumentHandle<ViewState> = {
    path: opened.path,
    source,
    active,
    initialViewState: opened.viewState ?? undefined,
    onChange,
    onViewState,
    onPersist,
    onFlushPendingChange,
  };
  return <Fragment key={opened.path}>{editor(handle)}</Fragment>;
}
