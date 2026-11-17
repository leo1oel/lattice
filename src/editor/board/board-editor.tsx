import "./board-asset-urls";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react";
import {
  CaptureUpdateAction, Excalidraw, FONT_FAMILY, MainMenu, WelcomeScreen, getSceneVersion,
} from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState, UIOptions,
} from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import "./board-editor.css";
import type { BoardFileViewState } from "../../app-types";
import type { Theme } from "../../settings/app-settings";
import {
  mergeExternalElements, parseBoardScene, savedVersions, serializeBoardScene,
} from "./board-store";

const SERIALIZE_DEBOUNCE_MS = 300;

/**
 * What Lattice keeps of Excalidraw's chrome: no collaboration, file
 * open/save, JSON export (it links Excalidraw+), theme toggle or canvas
 * background (both follow Lattice). The image export stays.
 */
const UI_OPTIONS: Partial<UIOptions> = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: true,
    export: false,
    loadScene: false,
    saveAsImage: true,
    saveToActiveFile: false,
    toggleTheme: null,
  },
  tools: { image: true },
};

/**
 * New elements start with clean strokes and a non-handwritten face so a
 * board matches the app; both stay a pick away. The canvas is transparent:
 * the board's sheet (`--board-canvas-surface`) shows through.
 */
const DEFAULT_APP_STATE = {
  currentItemRoughness: 0,
  currentItemFontFamily: FONT_FAMILY.Nunito,
  viewBackgroundColor: "transparent",
} satisfies Partial<AppState>;

export type BoardEditorProps = {
  /** Workspace-relative path used to route Agent shape tools to this board. */
  path: string;
  /** Initial .excalidraw JSON. The board owns its state after mount; later changes merge in. */
  source: string;
  onChange: (next: string) => void;
  /** Publish a pending debounced serialization before switching or closing panes. */
  onFlushPendingChange?: (flush: (() => boolean) | null) => void;
  /** Only the focused board owns the global Agent canvas tool adapter. */
  active?: boolean;
  /** Per-user scroll and zoom. They never enter the .excalidraw file. */
  initialViewState?: BoardFileViewState;
  onViewState?: (state: BoardFileViewState) => void;
  /** The resolved Lattice theme; "follow system" is resolved by the caller. */
  theme: Theme;
};

function initialData(source: string, view: BoardFileViewState | undefined): ExcalidrawInitialDataState {
  const scene = parseBoardScene(source);
  const elements = scene?.elements ?? [];
  return {
    elements,
    files: scene?.files ?? {},
    appState: {
      ...DEFAULT_APP_STATE,
      ...scene?.grid,
      ...(view ? { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom as AppState["zoom"]["value"] } } : {}),
    },
    scrollToContent: !view && elements.length > 0,
  };
}

/** A count that moves with every element edit and every added image. */
const sceneVersion = (elements: readonly OrderedExcalidrawElement[], files: BinaryFiles) => (
  `${getSceneVersion(elements)}:${Object.keys(files).length}`
);

export function BoardEditor({
  source,
  onChange,
  onFlushPendingChange,
  initialViewState,
  onViewState,
  theme,
}: BoardEditorProps) {
  const { i18n } = useLingui();
  const langCode = i18n.locale === "zh-CN" ? "zh-CN" : "en";
  const callbacksRef = useRef({ onChange, onViewState });
  useLayoutEffect(() => {
    callbacksRef.current = { onChange, onViewState };
  }, [onChange, onViewState]);
  // The scene is read once per mount (the canvas keys this component by file
  // path); later source changes merge in below.
  const [initial] = useState(() => initialData(source, initialViewState));
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  // What the file holds as far as this board knows: the text last written or
  // merged (an incoming source equal to it is our own echo), each element's
  // version in it, and the scene version it was taken at.
  const fileRef = useRef({
    source,
    versions: savedVersions(initial.elements as OrderedExcalidrawElement[]),
    scene: sceneVersion(initial.elements as OrderedExcalidrawElement[], initial.files ?? {}),
  });
  const timerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<{ frame: number | null; last: BoardFileViewState | null }>({ frame: null, last: initialViewState ?? null });

  const flush = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElementsIncludingDeleted();
    const json = serializeBoardScene(elements, api.getAppState(), api.getFiles());
    fileRef.current = { source: json, versions: savedVersions(elements), scene: sceneVersion(elements, api.getFiles()) };
    callbacksRef.current.onChange(json);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useLayoutEffect(() => {
    if (!onFlushPendingChange) return;
    onFlushPendingChange(() => {
      if (timerRef.current !== null) flushRef.current();
      return true;
    });
    return () => onFlushPendingChange(null);
  }, [onFlushPendingChange]);

  // Commit pending edits on unmount, so switching files never loses the last
  // stroke, and report where the view was left.
  useLayoutEffect(() => () => {
    if (timerRef.current !== null) flushRef.current();
    const view = viewRef.current;
    if (view.frame !== null) window.cancelAnimationFrame(view.frame);
    if (view.last) callbacksRef.current.onViewState?.(view.last);
    apiRef.current = null;
  }, []);

  const handleChange = (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    const view = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value };
    const last = viewRef.current.last;
    if (!last || last.scrollX !== view.scrollX || last.scrollY !== view.scrollY || last.zoom !== view.zoom) {
      viewRef.current.last = view;
      viewRef.current.frame ??= window.requestAnimationFrame(() => {
        viewRef.current.frame = null;
        if (viewRef.current.last) callbacksRef.current.onViewState?.(viewRef.current.last);
      });
    }
    // The live element count, for checks that cannot read Excalidraw's canvas
    // (the GPUI board island's end-to-end scenario).
    const live = String(elements.reduce((count, element) => count + (element.isDeleted ? 0 : 1), 0));
    if (rootRef.current && rootRef.current.dataset.elements !== live) rootRef.current.dataset.elements = live;
    // onChange also fires for selection, hover and view changes; only an edit
    // to the scene is written.
    if (sceneVersion(elements, files) === fileRef.current.scene) return;
    timerRef.current ??= window.setTimeout(() => flushRef.current(), SERIALIZE_DEBOUNCE_MS);
  };

  // Excalidraw takes ⌘/Ctrl+P on its container to toast a hint about its own
  // command palette and prevents the default, so the app's Quick open never
  // sees it. Catch the press before Excalidraw does and replay it from
  // outside the board, where it bubbles to the window's shortcut listener.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "p") return;
      event.stopPropagation();
      event.preventDefault();
      const { key, code, metaKey, ctrlKey } = event;
      root.parentElement?.dispatchEvent(new KeyboardEvent("keydown", {
        key, code, metaKey, ctrlKey, bubbles: true, cancelable: true, composed: true,
      }));
    };
    root.addEventListener("keydown", onKeyDown, true);
    return () => root.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // An outside change to the file (disk reload, git, Overleaf) merges in.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || source === fileRef.current.source) return;
    const scene = parseBoardScene(source);
    if (!scene) return;
    const elements = mergeExternalElements(
      api.getSceneElementsIncludingDeleted(), scene.elements, fileRef.current.versions, api.getAppState(),
    );
    api.addFiles(Object.values(scene.files));
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    fileRef.current = { source, versions: savedVersions(scene.elements), scene: sceneVersion(scene.elements, scene.files) };
  }, [source]);

  return (
    <div ref={rootRef} className="board-editor-root" data-tour="board-workspace">
      <Excalidraw
        initialData={initial}
        excalidrawAPI={(api) => {
          apiRef.current = api;
        }}
        onChange={handleChange}
        theme={theme}
        langCode={langCode}
        UIOptions={UI_OPTIONS}
        aiEnabled={false}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Hints.MenuHint />
          <WelcomeScreen.Hints.ToolbarHint />
          <WelcomeScreen.Hints.HelpHint />
        </WelcomeScreen>
      </Excalidraw>
    </div>
  );
}
