/**
 * The slides island: the Tauri app's Open Slide workspace
 * (`src/editor/presentation/open-slide-workspace.tsx`) as it is, its deck's
 * editor framed from the Open Slide runtime that lattice-core supervises.
 *
 * The workspace talks to the runtime itself (loopback HTTP, as in the Tauri
 * app) and to its owner in the GPUI app (`src/structured/slides.rs` there)
 * through Tauri's `invoke`, which this page sends over the bridge: the lease
 * (`presentation_ensure_ready`, `presentation_release`), the refresh of the
 * runtime's copy, and the reads it makes. A save in Open Slide is a mutation
 * the owner applies to the project (`slides:mutation`) and answers with the
 * bytes that landed, as `use-apply-open-slide-mutation.ts` does.
 *
 * Host to page, beside the document protocol's `doc:open`, `doc:source`,
 * `doc:active` and `doc:locale`:
 *   slides:files-changed  { root, paths }   the project watcher's burst
 */
import "../shared/install";
import { Fragment, useEffect, useReducer } from "react";
import { mount, activateLocale } from "../shared/boot";
import { host, useHostTheme } from "../shared/host";
import { emitTauriEvent } from "../shared/tauri-internals";
import { OpenSlideWorkspace } from "../../../src/editor/presentation/open-slide-workspace";
import type { OpenSlideMutation, OpenSlideSyncOperation } from "../../../src/editor/presentation/open-slide-bridge";
import type { OpenSlideFileViewState } from "../../../src/app-types";
import { showError } from "../../../src/app/notify";

type Locale = "en" | "zh-CN";

type SlidesOpen = {
  projectRoot: string;
  path: string;
  source: string;
  editable: boolean;
  viewState?: OpenSlideFileViewState | null;
  locale: Locale;
  active: boolean;
};

type State = { opened: SlidesOpen | null; source: string; active: boolean; locale: Locale; ready: boolean };

type Action =
  | { type: "open"; open: SlidesOpen }
  | { type: "source"; source: string }
  | { type: "active"; active: boolean }
  | { type: "locale"; locale: Locale }
  | { type: "ready" };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "open":
      return { ...state, opened: action.open, source: action.open.source, active: action.open.active, locale: action.open.locale };
    case "source":
      return { ...state, source: action.source };
    case "active":
      return { ...state, active: action.active };
    case "locale":
      return { ...state, locale: action.locale };
    case "ready":
      return { ...state, ready: true };
  }
}

const onMutation = (mutation: OpenSlideMutation) => host().request<OpenSlideSyncOperation[]>("slides:mutation", mutation);
const onViewState = (viewState: OpenSlideFileViewState) => host().post("doc:view-state", { viewState });

function Slides() {
  const [{ opened, source, active, locale, ready }, dispatch] = useReducer(reduce, {
    opened: null, source: "", active: true, locale: "en", ready: false,
  });
  const theme = useHostTheme();

  useEffect(() => {
    const bridge = host();
    const stops = [
      bridge.on("doc:open", (payload) => {
        const open = payload as SlidesOpen;
        dispatch({ type: "open", open });
        void activateLocale(open.locale).then(() => dispatch({ type: "ready" }));
      }),
      bridge.on("doc:source", (payload) => dispatch({ type: "source", source: (payload as { source: string }).source })),
      bridge.on("doc:active", (payload) => dispatch({ type: "active", active: Boolean((payload as { active: boolean }).active) })),
      // Open Slide saves each edit itself; nothing waits here.
      bridge.on("doc:flush", () => bridge.post("doc:flushed")),
      bridge.on("doc:locale", (payload) => {
        const next = (payload as { locale: Locale }).locale;
        void activateLocale(next).then(() => dispatch({ type: "locale", locale: next }));
      }),
      // What `src/project/project-files-changed.ts` listens for.
      bridge.on("slides:files-changed", (payload) => emitTauriEvent("project-fs-changed", payload)),
    ];
    bridge.ready();
    return () => { for (const stop of stops) stop(); };
  }, []);

  useEffect(() => {
    if (!opened || !ready) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => host().post("doc:drawn"));
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [opened, ready]);

  if (!opened || !ready) return null;
  return (
    <Fragment key={`${opened.projectRoot}\n${opened.path}`}>
      <OpenSlideWorkspace
        projectRoot={opened.projectRoot}
        path={opened.path}
        source={source}
        editable={opened.editable}
        locale={locale}
        theme={theme}
        active={active}
        onMutation={onMutation}
        // As the app's canvas reports it (`use-document-surfaces.tsx`); the
        // toast reaches GPUI's stack through the page's toast relay.
        onError={showError}
        onAgentRequest={(request) => host().post("slides:agent-request", request)}
        initialViewState={opened.viewState ?? undefined}
        onViewState={onViewState}
      />
    </Fragment>
  );
}

mount(() => <Slides />);
