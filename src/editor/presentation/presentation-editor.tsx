import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { useLingui } from "@lingui/react/macro";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Printer,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import Reveal from "reveal.js";
import Highlight from "reveal.js/plugin/highlight";
import Notes from "reveal.js/plugin/notes";
import type { PresentationFileViewState } from "../../app-types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { IconButton } from "../../components/ui/icon-button";
import { markdownToHtml } from "../../open-knowledge-core/markdown/mdast-to-html";
import { isBrowserHosted } from "../../platform/browser-runtime";
import { notifyError } from "../../telemetry/app-notify";
import { toMessage } from "../../app-utils";
import { CodeMirrorHost } from "../codemirror-host";
import {
  deleteSlide as deleteSlideFromSource,
  insertSlideAfter,
  parsePresentation,
  type PresentationDeck,
  type PresentationTheme,
  type PresentationTransition,
  slideSummary,
  updateFrontmatterSetting,
} from "./presentation-model";
import "reveal.js/reveal.css";
import "./presentation-editor.css";

export type PresentationEditorProps = {
  path: string;
  source: string;
  onChange: (next: string) => void;
  onPersist: () => Promise<boolean>;
  editable?: boolean;
  active?: boolean;
  languageExtensions?: Extension[];
  collabExtensions?: Extension[];
  mode?: PresentationFileViewState["mode"];
  onModeChange?: (mode: PresentationFileViewState["mode"]) => void;
  initialViewState?: PresentationFileViewState;
  onViewState?: (state: PresentationFileViewState) => void;
  onLoadAsset?: (path: string) => Promise<string | null>;
  onOpenProjectPath?: (path: string) => void;
};

type PresentationMode = PresentationFileViewState["mode"];
type ProjectAssetLoader = NonNullable<PresentationEditorProps["onLoadAsset"]>;
type LoadedProjectImage = { loader: ProjectAssetLoader; dataUrl: string };
type RevealSlideChangedEvent = Event & { indexh?: number };

const SOURCE_MIN_WIDTH = 240;
const PREVIEW_MIN_WIDTH = 340;
const COMPACT_SOURCE_MIN_WIDTH = 140;
const COMPACT_PREVIEW_MIN_WIDTH = 240;
const THUMBNAIL_RAIL_MIN_WIDTH = 132;
const THUMBNAIL_RAIL_DEFAULT_WIDTH = 176;
const THUMBNAIL_RAIL_MAX_WIDTH = 280;
const WHEEL_NAVIGATION_THRESHOLD = 36;
const WHEEL_NAVIGATION_COOLDOWN_MS = 320;
const WHEEL_GESTURE_RESET_MS = 180;
const PROJECT_IMAGE_RETRY_DELAYS_MS = [0, 150, 500] as const;
// These are CSS custom-property names, not text shown to the user.
// eslint-disable-next-line lingui/no-unlocalized-strings
const THUMBNAIL_RAIL_WIDTH_PROPERTY = "--presentation-thumbnail-width";
// eslint-disable-next-line lingui/no-unlocalized-strings
const THUMBNAIL_SCALE_PROPERTY = "--presentation-thumbnail-scale";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function resolveProjectPath(documentPath: string, target: string): string | null {
  const rawPath = target.split(/[?#]/, 1)[0];
  if (!rawPath || rawPath.startsWith("/") || rawPath.startsWith("\\") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath).replace(/\\/g, "/");
  } catch {
    return null;
  }
  const parts = documentPath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}

function withLoadedProjectImages(
  html: string,
  documentPath: string,
  loader: PresentationEditorProps["onLoadAsset"],
  loadedImages: ReadonlyMap<string, LoadedProjectImage>,
): string {
  if (!loader || loadedImages.size === 0) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;
  for (const image of template.content.querySelectorAll<HTMLImageElement>("img[src]")) {
    const original = image.dataset.presentationSource ?? image.getAttribute("src") ?? "";
    const projectPath = resolveProjectPath(documentPath, original);
    const loaded = projectPath ? loadedImages.get(projectPath) : undefined;
    if (!loaded || loaded.loader !== loader) continue;
    image.dataset.presentationSource = original;
    image.src = loaded.dataUrl;
    changed = true;
  }
  return changed ? template.innerHTML : html;
}

function collectProjectImagePaths(html: string, documentPath: string, paths: Set<string>) {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll<HTMLImageElement>("img[src]")) {
    const projectPath = resolveProjectPath(documentPath, image.getAttribute("src") ?? "");
    if (projectPath) paths.add(projectPath);
  }
}

function safeExternalUrl(target: string): string | null {
  try {
    const url = new URL(target);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function slideIndexAt(deck: PresentationDeck, position: number): number {
  const index = deck.slides.findIndex((slide, slideIndex) => (
    position >= slide.start
    && (position < slide.end || slideIndex === deck.slides.length - 1)
  ));
  return index < 0 ? 0 : index;
}

export function PresentationEditor(props: PresentationEditorProps) {
  const { t } = useLingui();
  const { mode: controlledMode, onLoadAsset, onModeChange, onViewState } = props;
  const editable = props.editable !== false;
  const [localMode, setLocalMode] = useState<PresentationMode>(props.initialViewState?.mode ?? "split");
  const mode = controlledMode ?? localMode;
  const [slide, setSlide] = useState(props.initialViewState?.slide ?? 0);
  const [thumbnailRailOpen, setThumbnailRailOpen] = useState(
    props.initialViewState?.thumbnailRailOpen ?? true,
  );
  const [thumbnailRailWidth, setThumbnailRailWidth] = useState(() => clamp(
    props.initialViewState?.thumbnailRailWidth ?? THUMBNAIL_RAIL_DEFAULT_WIDTH,
    THUMBNAIL_RAIL_MIN_WIDTH,
    THUMBNAIL_RAIL_MAX_WIDTH,
  ));
  const initialSplitRatio = props.initialViewState?.splitRatio;
  const [splitRatio, setSplitRatio] = useState(
    typeof initialSplitRatio === "number" ? clamp(initialSplitRatio, 0.2, 0.8) : 0.5,
  );
  const [slideEditing, setSlideEditing] = useState(false);
  const [slideDraft, setSlideDraft] = useState("");
  const [loadedProjectImages, setLoadedProjectImages] = useState<Map<string, LoadedProjectImage>>(
    () => new Map(),
  );
  const deferredSource = useDeferredValue(props.source);
  const deck = useMemo(() => parsePresentation(deferredSource), [deferredSource]);
  const clampedSlide = Math.max(0, Math.min(slide, deck.slides.length - 1));
  const slideSummaries = useMemo(() => deck.slides.map(slideSummary), [deck.slides]);
  const slideMarkup = useMemo(() => deck.slides.map((item, index) => ({
    layout: index === 0 && /^\s*#\s+/m.test(item.body)
      ? "title"
      : slideSummaries[index].imageSource
        ? "media"
        : "default",
    bodyHtml: markdownToHtml(item.body),
    notesHtml: markdownToHtml(item.notes),
  })), [deck.slides, slideSummaries]);
  const projectImagePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const slide of slideMarkup) {
      collectProjectImagePaths(slide.bodyHtml, props.path, paths);
      collectProjectImagePaths(slide.notesHtml, props.path, paths);
    }
    return [...paths];
  }, [props.path, slideMarkup]);
  const renderedSlides = useMemo(() => slideMarkup.map((item) => ({
    layout: item.layout,
    bodyHtml: withLoadedProjectImages(
      item.bodyHtml,
      props.path,
      onLoadAsset,
      loadedProjectImages,
    ),
    notesHtml: withLoadedProjectImages(
      item.notesHtml,
      props.path,
      onLoadAsset,
      loadedProjectImages,
    ),
  })), [loadedProjectImages, onLoadAsset, props.path, slideMarkup]);
  const shellRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const thumbnailListRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const revealRootRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<InstanceType<typeof Reveal> | null>(null);
  const revealReadyRef = useRef(false);
  const revealRefreshFramesRef = useRef<number[]>([]);
  const editorRef = useRef<EditorView | null>(null);
  const deckRef = useRef(deck);
  const activeRef = useRef(props.active !== false);
  const modeRef = useRef(mode);
  const modeChangeRef = useRef<(mode: PresentationMode) => void>(() => undefined);
  const slideRef = useRef(clampedSlide);
  const presentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasPresentationFullscreenRef = useRef(false);
  const fullscreenRestoreModeRef = useRef<PresentationMode | null>(null);
  const thumbnailResizeCleanupRef = useRef<(() => void) | null>(null);
  const splitResizeCleanupRef = useRef<(() => void) | null>(null);
  const printRestoreModeRef = useRef<PresentationMode | null>(null);
  const printCleanupRef = useRef<(() => void) | null>(null);
  const cancelSlideEditRef = useRef(false);
  const styleTriggerRef = useRef<HTMLButtonElement>(null);
  const styleMenuOpenedByPointerRef = useRef(false);
  const wheelNavigationRef = useRef({
    delta: 0,
    lastEventAt: 0,
    blockedUntil: 0,
  });

  const changeMode = useCallback((nextMode: PresentationMode) => {
    if (controlledMode === undefined) setLocalMode(nextMode);
    onModeChange?.(nextMode);
  }, [controlledMode, onModeChange]);

  useLayoutEffect(() => {
    deckRef.current = deck;
    activeRef.current = props.active !== false;
    modeRef.current = mode;
    modeChangeRef.current = changeMode;
    slideRef.current = clampedSlide;
  }, [changeMode, clampedSlide, deck, mode, props.active]);

  const cancelRevealRefresh = useCallback(() => {
    for (const frame of revealRefreshFramesRef.current) {
      window.cancelAnimationFrame(frame);
    }
    revealRefreshFramesRef.current = [];
  }, []);

  const scheduleRevealRefresh = useCallback(() => {
    cancelRevealRefresh();
    const firstFrame = window.requestAnimationFrame(() => {
      revealRefreshFramesRef.current = [];
      const reveal = revealRef.current;
      if (!reveal || !revealReadyRef.current) return;
      // React owns the slide DOM while Reveal owns its navigation classes and
      // geometry. Reconcile both after a hidden preview becomes visible or an
      // asynchronously loaded asset replaces the rendered markup.
      reveal.sync();
      reveal.slide(slideRef.current);
      reveal.layout();
      const secondFrame = window.requestAnimationFrame(() => {
        revealRefreshFramesRef.current = [];
        if (revealRef.current === reveal && revealReadyRef.current) reveal.layout();
      });
      revealRefreshFramesRef.current = [secondFrame];
    });
    revealRefreshFramesRef.current = [firstFrame];
  }, [cancelRevealRefresh]);

  const editorExtensions = useMemo(() => [
    ...(props.languageExtensions ?? []),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": t`Presentation Markdown source` }),
    ...(props.collabExtensions ?? []),
  ], [props.collabExtensions, props.languageExtensions, t]);

  const constrainSplitRatio = useCallback((ratio: number) => {
    const width = stageRef.current?.getBoundingClientRect().width ?? 0;
    if (!width) return clamp(ratio, 0.2, 0.8);
    const tracksWidth = Math.max(1, width - 1);
    if (tracksWidth < COMPACT_SOURCE_MIN_WIDTH + COMPACT_PREVIEW_MIN_WIDTH) {
      // A file pane can itself be narrow inside the app's two-file layout.
      // Keep both halves inside that pane instead of letting CSS minimums
      // overflow and crop the slide; below this width preview gets priority.
      return 0.36;
    }
    const compact = tracksWidth < SOURCE_MIN_WIDTH + PREVIEW_MIN_WIDTH;
    const sourceMinimum = compact ? COMPACT_SOURCE_MIN_WIDTH : SOURCE_MIN_WIDTH;
    const previewMinimum = compact ? COMPACT_PREVIEW_MIN_WIDTH : PREVIEW_MIN_WIDTH;
    const minimum = sourceMinimum / tracksWidth;
    const maximum = 1 - previewMinimum / tracksWidth;
    return clamp(ratio, minimum, maximum);
  }, []);

  const constrainThumbnailRailWidth = useCallback((width: number) => {
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width ?? 0;
    const stageMinimum = mode === "split"
      ? COMPACT_SOURCE_MIN_WIDTH + COMPACT_PREVIEW_MIN_WIDTH + 1
      : COMPACT_PREVIEW_MIN_WIDTH;
    const maximum = workspaceWidth
      ? Math.max(
        THUMBNAIL_RAIL_MIN_WIDTH,
        Math.min(THUMBNAIL_RAIL_MAX_WIDTH, workspaceWidth - stageMinimum - 1),
      )
      : THUMBNAIL_RAIL_MAX_WIDTH;
    return clamp(width, THUMBNAIL_RAIL_MIN_WIDTH, maximum);
  }, [mode]);

  useEffect(() => {
    onViewState?.({
      slide: clampedSlide,
      mode,
      thumbnailRailOpen,
      thumbnailRailWidth,
      splitRatio,
    });
  }, [clampedSlide, mode, onViewState, splitRatio, thumbnailRailOpen, thumbnailRailWidth]);

  useEffect(() => {
    const root = revealRootRef.current;
    if (!root) return;
    let disposed = false;
    const reveal = new Reveal(root, {
      embedded: true,
      keyboard: props.active !== false,
      keyboardCondition: "focused",
      controls: false,
      controlsTutorial: false,
      progress: true,
      hash: false,
      history: false,
      navigationMode: "linear",
      slideNumber: false,
      width: 1600,
      height: 900,
      margin: 0.06,
      transition: deck.transition,
      plugins: [Highlight, Notes],
    });
    const onSlideChanged: EventListener = (event) => {
      setSlide((event as RevealSlideChangedEvent).indexh ?? 0);
    };
    revealRef.current = reveal;
    reveal.on("slidechanged", onSlideChanged);
    void reveal.initialize().then(() => {
      if (disposed) return;
      revealReadyRef.current = true;
      reveal.configure({
        keyboard: activeRef.current,
        transition: deckRef.current.transition,
      });
      reveal.sync();
      reveal.slide(slideRef.current);
      if (modeRef.current !== "source") reveal.layout();
    }).catch(() => {
      // The source editor remains usable if WebKit cannot initialize Reveal.
    });
    return () => {
      disposed = true;
      revealReadyRef.current = false;
      reveal.off("slidechanged", onSlideChanged);
      if (revealRef.current === reveal) revealRef.current = null;
      reveal.destroy();
    };
    // One Reveal instance owns this component's stable preview DOM. Source and
    // settings changes synchronize through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const reveal = revealRef.current;
    if (!reveal || !revealReadyRef.current) return;
    reveal.configure({ transition: deck.transition });
    scheduleRevealRefresh();
  }, [clampedSlide, deck.transition, renderedSlides, scheduleRevealRefresh]);

  useEffect(() => {
    const reveal = revealRef.current;
    if (!reveal || !revealReadyRef.current) return;
    reveal.configure({ keyboard: props.active !== false });
  }, [props.active]);

  useEffect(() => {
    if (mode === "source") {
      cancelRevealRefresh();
      return;
    }
    scheduleRevealRefresh();
    return cancelRevealRefresh;
  }, [cancelRevealRefresh, mode, scheduleRevealRefresh]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || mode === "source" || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      if (mode === "split") setSplitRatio((current) => constrainSplitRatio(current));
      if (revealReadyRef.current) revealRef.current?.layout();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    fit();
    return () => observer.disconnect();
  }, [constrainSplitRatio, mode]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || mode === "source" || !thumbnailRailOpen || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      setThumbnailRailWidth((current) => constrainThumbnailRailWidth(current));
      if (revealReadyRef.current) revealRef.current?.layout();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(workspace);
    fit();
    return () => observer.disconnect();
  }, [constrainThumbnailRailWidth, mode, thumbnailRailOpen]);

  useLayoutEffect(() => {
    const list = thumbnailListRef.current;
    if (!list || mode === "source" || !thumbnailRailOpen) return;
    const fit = () => {
      const card = list.querySelector<HTMLElement>(".presentation-thumbnail-card");
      if (!card || card.clientWidth <= 0) return;
      list.style.setProperty(THUMBNAIL_SCALE_PROPERTY, `${card.clientWidth / 1600}`);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(list);
    return () => observer.disconnect();
  }, [deck.slides.length, mode, thumbnailRailOpen]);

  useEffect(() => {
    if (!onLoadAsset) return;
    const missingPaths = projectImagePaths.filter((projectPath) => {
      const loaded = loadedProjectImages.get(projectPath);
      return !loaded || loaded.loader !== onLoadAsset;
    });
    if (!missingPaths.length) return;
    let cancelled = false;
    void Promise.all(missingPaths.map(async (projectPath) => {
      for (const delay of PROJECT_IMAGE_RETRY_DELAYS_MS) {
        if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (cancelled) return null;
        try {
          const dataUrl = await onLoadAsset(projectPath);
          if (cancelled) return null;
          if (dataUrl) return [projectPath, dataUrl] as const;
        } catch {
          // A project switch or tutorial reset can make the first read race
          // the asset landing on disk. Retry the bounded sequence above.
        }
      }
      return null;
    })).then((loadedImages) => {
      if (cancelled) return;
      const availableImages = loadedImages.filter((loaded) => loaded !== null);
      if (!availableImages.length) return;
      setLoadedProjectImages((current) => {
        const next = new Map(current);
        for (const [projectPath, dataUrl] of availableImages) {
          next.set(projectPath, { loader: onLoadAsset, dataUrl });
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [loadedProjectImages, onLoadAsset, projectImagePaths]);

  const navigate = useCallback((nextSlide: number, moveCursor = false) => {
    const index = Math.max(0, Math.min(nextSlide, deck.slides.length - 1));
    // Keep imperative controls current even when two navigation events happen
    // before React commits the first state update (for example, an input blur
    // followed by clicking the next arrow).
    slideRef.current = index;
    setSlide(index);
    revealRef.current?.slide(index);
    if (!moveCursor || mode === "preview") return;
    const view = editorRef.current;
    if (!view) return;
    view.dispatch({
      selection: { anchor: deck.slides[index].start },
      effects: EditorView.scrollIntoView(deck.slides[index].start, { y: "center" }),
    });
    view.focus();
  }, [deck.slides, mode]);

  const commitSlideDraft = () => {
    setSlideEditing(false);
    if (cancelSlideEditRef.current) {
      cancelSlideEditRef.current = false;
      return;
    }
    const page = Number(slideDraft);
    if (Number.isInteger(page) && page >= 1) navigate(page - 1);
  };

  const addSlide = () => {
    const nextSource = insertSlideAfter(props.source, clampedSlide);
    const nextDeck = parsePresentation(nextSource);
    const nextSlide = props.source === ""
      ? 0
      : Math.min(clampedSlide + 1, nextDeck.slides.length - 1);
    props.onChange(nextSource);
    setSlide(nextSlide);
    window.requestAnimationFrame(() => {
      const view = editorRef.current;
      if (!view || mode === "preview") return;
      const position = nextDeck.slides[nextSlide].start;
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: "center" }),
      });
      view.focus();
    });
  };

  const removeSlide = (index: number) => {
    if (!editable || deck.slides.length <= 1) return;
    const nextSource = deleteSlideFromSource(props.source, index);
    const nextDeck = parsePresentation(nextSource);
    const nextSlide = index < clampedSlide
      ? clampedSlide - 1
      : Math.min(clampedSlide, nextDeck.slides.length - 1);
    props.onChange(nextSource);
    setSlide(nextSlide);
    window.requestAnimationFrame(() => {
      const view = editorRef.current;
      if (!view || mode === "preview") return;
      const position = nextDeck.slides[nextSlide].start;
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: "center" }),
      });
      view.focus();
    });
  };

  const beginSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    splitResizeCleanupRef.current?.();
    let latest = splitRatio;
    let layoutFrame = 0;
    let finished = false;
    document.body.classList.add("resizing-split");
    const handleMove = (moveEvent: PointerEvent) => {
      const bounds = stageRef.current?.getBoundingClientRect();
      if (!bounds?.width) return;
      latest = constrainSplitRatio((moveEvent.clientX - bounds.left) / Math.max(1, bounds.width - 1));
      setSplitRatio(latest);
      if (!layoutFrame) {
        layoutFrame = window.requestAnimationFrame(() => {
          layoutFrame = 0;
          revealRef.current?.layout();
        });
      }
    };
    const cleanup = (commit: boolean) => {
      if (finished) return;
      finished = true;
      document.body.classList.remove("resizing-split");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
      if (splitResizeCleanupRef.current === cancel) splitResizeCleanupRef.current = null;
      if (commit) {
        setSplitRatio(latest);
        revealRef.current?.layout();
      }
    };
    const finish = () => cleanup(true);
    const cancel = () => cleanup(false);
    splitResizeCleanupRef.current = cancel;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const beginThumbnailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    thumbnailResizeCleanupRef.current?.();
    let latest = thumbnailRailWidth;
    let layoutFrame = 0;
    let finished = false;
    document.body.classList.add("resizing-slide-navigator");
    const handleMove = (moveEvent: PointerEvent) => {
      const workspace = workspaceRef.current;
      const bounds = workspace?.getBoundingClientRect();
      if (!workspace || !bounds?.width) return;
      latest = constrainThumbnailRailWidth(moveEvent.clientX - bounds.left);
      workspace.style.setProperty(THUMBNAIL_RAIL_WIDTH_PROPERTY, `${latest}px`);
      if (!layoutFrame) {
        layoutFrame = window.requestAnimationFrame(() => {
          layoutFrame = 0;
          revealRef.current?.layout();
        });
      }
    };
    const cleanup = (commit: boolean) => {
      if (finished) return;
      finished = true;
      document.body.classList.remove("resizing-slide-navigator");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
      if (thumbnailResizeCleanupRef.current === cancel) thumbnailResizeCleanupRef.current = null;
      if (commit) setThumbnailRailWidth(latest);
      else workspaceRef.current?.style.setProperty(
        THUMBNAIL_RAIL_WIDTH_PROPERTY,
        `${thumbnailRailWidth}px`,
      );
      revealRef.current?.layout();
    };
    const finish = () => cleanup(true);
    const cancel = () => cleanup(false);
    thumbnailResizeCleanupRef.current = cancel;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const nudgeThumbnailRail = (delta: number) => {
    setThumbnailRailWidth((current) => constrainThumbnailRailWidth(current + delta));
    window.requestAnimationFrame(() => revealRef.current?.layout());
  };

  const nudgeSplit = (delta: number) => {
    setSplitRatio((current) => constrainSplitRatio(current + delta));
    window.requestAnimationFrame(() => revealRef.current?.layout());
  };

  const startPresentation = useCallback(async () => {
    const preview = previewRef.current;
    const restoreTemporaryMode = () => {
      const restoreMode = fullscreenRestoreModeRef.current;
      fullscreenRestoreModeRef.current = null;
      if (restoreMode) modeChangeRef.current(restoreMode);
    };
    if (!preview?.requestFullscreen) {
      restoreTemporaryMode();
      return;
    }
    try {
      // requestFullscreen must run in the click's user-activation task. The
      // source-to-preview switch is flushed by present() before this call.
      await preview.requestFullscreen();
      scheduleRevealRefresh();
      revealRootRef.current?.focus();
    } catch {
      // Fullscreen can be denied by WebKit or system policy; editing continues.
      restoreTemporaryMode();
    }
  }, [scheduleRevealRefresh]);

  const startPrint = useCallback(async (restoreMode: PresentationMode | null = null) => {
    const shell = shellRef.current;
    if (!shell || printCleanupRef.current) return;
    printRestoreModeRef.current = restoreMode;
    const root = document.documentElement;
    root.classList.add("lattice-presentation-print");
    shell.dataset.presentationPrinting = "true";
    let timer = 0;
    let listeningForBrowserPrint = false;
    const cleanup = () => {
      root.classList.remove("lattice-presentation-print");
      delete shell.dataset.presentationPrinting;
      if (listeningForBrowserPrint) window.removeEventListener("afterprint", cleanup);
      window.clearTimeout(timer);
      if (printCleanupRef.current === cleanup) printCleanupRef.current = null;
      const modeToRestore = printRestoreModeRef.current;
      printRestoreModeRef.current = null;
      if (modeToRestore && modeRef.current === "preview") modeChangeRef.current(modeToRestore);
    };
    printCleanupRef.current = cleanup;
    if (!isBrowserHosted()) {
      try {
        await invoke<boolean>("print_webview");
      } catch (reason) {
        notifyError(t`Presentation`, t`Could not open the print dialog`, {
          detail: toMessage(reason),
        });
      } finally {
        cleanup();
      }
      return;
    }
    listeningForBrowserPrint = true;
    window.addEventListener("afterprint", cleanup, { once: true });
    timer = window.setTimeout(cleanup, 10_000);
    try {
      window.print();
    } catch (reason) {
      notifyError(t`Presentation`, t`Could not open the print dialog`, {
        detail: toMessage(reason),
      });
      cleanup();
    }
  }, [t]);

  const present = (event: ReactMouseEvent<HTMLButtonElement>) => {
    presentTriggerRef.current = event.currentTarget;
    fullscreenRestoreModeRef.current = mode === "source" ? "source" : null;
    if (mode === "source") flushSync(() => changeMode("preview"));
    void startPresentation();
  };

  const print = async () => {
    try {
      if (!await props.onPersist()) return;
    } catch {
      return;
    }
    if (modeRef.current !== "source") {
      void startPrint();
      return;
    }
    flushSync(() => changeMode("preview"));
    window.requestAnimationFrame(() => {
      if (modeRef.current !== "preview") return;
      revealRef.current?.layout();
      void startPrint("source");
    });
  };

  useEffect(() => {
    const onFullscreenChange = () => {
      const isPresentationFullscreen = document.fullscreenElement === previewRef.current;
      if (isPresentationFullscreen) {
        wasPresentationFullscreenRef.current = true;
        revealRootRef.current?.focus();
      } else {
        if (wasPresentationFullscreenRef.current) {
          wasPresentationFullscreenRef.current = false;
          presentTriggerRef.current?.focus();
        }
        const restoreMode = fullscreenRestoreModeRef.current;
        fullscreenRestoreModeRef.current = null;
        if (restoreMode) modeChangeRef.current(restoreMode);
      }
      scheduleRevealRefresh();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [scheduleRevealRefresh]);

  useEffect(() => () => {
    cancelRevealRefresh();
    fullscreenRestoreModeRef.current = null;
    thumbnailResizeCleanupRef.current?.();
    splitResizeCleanupRef.current?.();
    printRestoreModeRef.current = null;
    printCleanupRef.current?.();
  }, [cancelRevealRefresh]);

  const onPreviewClick = (event: ReactMouseEvent<HTMLElement>) => {
    const anchor = (event.target as Element).closest("a");
    if (anchor) {
      event.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      const external = safeExternalUrl(href);
      if (external) {
        void openUrl(external).catch(() => undefined);
        return;
      }
      const projectPath = resolveProjectPath(props.path, href);
      if (projectPath) props.onOpenProjectPath?.(projectPath);
      return;
    }

    if (document.fullscreenElement !== previewRef.current) return;
    const target = event.target as Element;
    if (target.closest([
      "button",
      "input",
      "label",
      "textarea",
      "select",
      "video",
      "audio",
    ].join(","))) return;
    navigate(slideRef.current + 1);
  };

  const onPreviewWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();

    const now = Date.now();
    const navigation = wheelNavigationRef.current;
    if (now < navigation.blockedUntil) return;
    if (now - navigation.lastEventAt > WHEEL_GESTURE_RESET_MS) navigation.delta = 0;

    const scale = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? previewRef.current?.clientHeight || 600
        : 1;
    const delta = event.deltaY * scale;
    if (navigation.delta && Math.sign(navigation.delta) !== Math.sign(delta)) {
      navigation.delta = 0;
    }
    navigation.delta += delta;
    navigation.lastEventAt = now;
    if (Math.abs(navigation.delta) < WHEEL_NAVIGATION_THRESHOLD) return;

    navigate(slideRef.current + Math.sign(navigation.delta));
    navigation.delta = 0;
    navigation.blockedUntil = now + WHEEL_NAVIGATION_COOLDOWN_MS;
  };

  const themeOptions: Array<{ value: PresentationTheme; label: string }> = [
    { value: "lattice", label: t`Lattice` },
    { value: "paper", label: t`Paper style` },
    { value: "midnight", label: t`Midnight` },
  ];
  const transitionOptions: Array<{ value: PresentationTransition; label: string }> = [
    { value: "none", label: t`None` },
    { value: "fade", label: t`Fade` },
    { value: "slide", label: t`Slide` },
    { value: "convex", label: t`Convex` },
    { value: "concave", label: t`Concave` },
    { value: "zoom", label: t`Zoom` },
  ];

  return (
    <div
      className={`presentation-editor presentation-theme-${deck.theme}`}
      data-tour="presentation-editor"
      ref={shellRef}
    >
      <div className="presentation-toolbar">
        {mode !== "source" && (
          <IconButton
            label={thumbnailRailOpen ? t`Hide slide navigator` : t`Show slide navigator`}
            onClick={() => setThumbnailRailOpen((open) => !open)}
          >
            {thumbnailRailOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </IconButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={styleTriggerRef}
              type="button"
              className="presentation-style-trigger"
              aria-label={t`Presentation style`}
              title={t`Presentation style`}
              disabled={!editable}
              onPointerDown={() => {
                styleMenuOpenedByPointerRef.current = true;
              }}
              onKeyDown={() => {
                styleMenuOpenedByPointerRef.current = false;
              }}
            >
              <Palette strokeWidth={1.5} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={6}
            className="presentation-style-menu"
            onKeyDownCapture={() => {
              styleMenuOpenedByPointerRef.current = false;
            }}
            onCloseAutoFocus={(event) => {
              if (!styleMenuOpenedByPointerRef.current) return;
              event.preventDefault();
              styleMenuOpenedByPointerRef.current = false;
              styleTriggerRef.current?.blur();
            }}
          >
            <DropdownMenuLabel>{t`Theme`}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={deck.theme}
              onValueChange={(value) => {
                const theme = themeOptions.find((option) => option.value === value)?.value;
                if (theme) props.onChange(updateFrontmatterSetting(props.source, "theme", theme));
              }}
            >
              {themeOptions.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t`Transition`}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={deck.transition}
              onValueChange={(value) => {
                const transition = transitionOptions.find((option) => option.value === value)?.value;
                if (transition) props.onChange(updateFrontmatterSetting(
                  props.source,
                  "transition",
                  transition,
                ));
              }}
            >
              {transitionOptions.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton label={t`Add slide`} disabled={!editable} onClick={addSlide}>
          <Plus />
        </IconButton>
        <IconButton
          label={t`Delete slide`}
          disabled={!editable || deck.slides.length <= 1}
          onClick={() => removeSlide(clampedSlide)}
        >
          <Trash2 />
        </IconButton>
        <span className="presentation-spacer" />
        <IconButton label={t`Present`} onClick={present}>
          <Maximize2 strokeWidth={1.5} />
        </IconButton>
        <IconButton label={t`Print / PDF`} onClick={() => void print()}>
          <Printer strokeWidth={1.5} />
        </IconButton>
      </div>
      <div
        ref={workspaceRef}
        className={`presentation-workspace mode-${mode}${mode !== "source" && thumbnailRailOpen ? " with-thumbnail-rail" : ""}`}
        style={{ [THUMBNAIL_RAIL_WIDTH_PROPERTY]: `${thumbnailRailWidth}px` } as React.CSSProperties}
      >
        {mode !== "source" && thumbnailRailOpen && (
          <nav className="presentation-thumbnails" aria-label={t`Slides`}>
            <div className="presentation-thumbnails-header">
              <strong>{t`Slides`}</strong>
              <span>{deck.slides.length}</span>
            </div>
            <div ref={thumbnailListRef} className="presentation-thumbnail-list">
              {deck.slides.map((item, index) => {
                const summary = slideSummaries[index];
                const renderedSlide = renderedSlides[index];
                return (
                  <ContextMenu key={`${item.start}-${index}`}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        className="presentation-thumbnail"
                        data-active={index === clampedSlide ? "true" : undefined}
                        aria-current={index === clampedSlide ? "page" : undefined}
                        aria-label={t`Slide ${index + 1}: ${summary.title}`}
                        onClick={() => navigate(index, true)}
                      >
                        <span className="presentation-thumbnail-number">{index + 1}</span>
                        <span className="presentation-thumbnail-card">
                          <span
                            className="presentation-thumbnail-canvas"
                            aria-hidden="true"
                          >
                            <div
                              className="reveal presentation-thumbnail-reveal"
                              inert
                            >
                              <div className="slides">
                                <section
                                  className="present presentation-slide-surface presentation-thumbnail-slide"
                                  data-layout={renderedSlide.layout}
                                  dangerouslySetInnerHTML={{
                                    __html: `<div class="presentation-slide-content">${renderedSlide.bodyHtml}</div>`,
                                  }}
                                />
                              </div>
                            </div>
                          </span>
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
                      <ContextMenuItem
                        variant="destructive"
                        disabled={!editable || deck.slides.length <= 1}
                        onSelect={() => removeSlide(index)}
                      >
                        <Trash2 />
                        {t`Delete slide`}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          </nav>
        )}
        {mode !== "source" && thumbnailRailOpen && (
          <div
            className="presentation-thumbnail-resizer"
            role="separator"
            aria-label={t`Resize slide navigator`}
            aria-orientation="vertical"
            aria-valuemin={THUMBNAIL_RAIL_MIN_WIDTH}
            aria-valuemax={THUMBNAIL_RAIL_MAX_WIDTH}
            aria-valuenow={Math.round(thumbnailRailWidth)}
            tabIndex={0}
            onPointerDown={beginThumbnailResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                nudgeThumbnailRail(-12);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                nudgeThumbnailRail(12);
              }
            }}
          />
        )}
        <div
          ref={stageRef}
          className={`presentation-stage mode-${mode}`}
          style={mode === "split" ? {
            gridTemplateColumns: `minmax(0, ${splitRatio}fr) 1px minmax(0, ${1 - splitRatio}fr)`,
          } : undefined}
        >
          {mode !== "preview" && (
            <section
              className="presentation-source source-editor"
              aria-label={t`Presentation Markdown source`}
            >
              <CodeMirrorHost
                className="code-editor-root"
                value={props.source}
                editable={editable}
                extensions={editorExtensions}
                onChange={props.onChange}
                onCreateEditor={(view) => {
                  editorRef.current = view;
                }}
                onUpdate={(update: ViewUpdate) => {
                  if (!update.selectionSet || !update.view.hasFocus) return;
                  navigate(slideIndexAt(
                    parsePresentation(update.state.doc.toString()),
                    update.state.selection.main.head,
                  ));
                }}
              />
            </section>
          )}
          {mode === "split" && (
            <div
              className="split-resizer"
              role="separator"
              aria-label={t`Resize source and presentation preview`}
              aria-orientation="vertical"
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={Math.round(splitRatio * 100)}
              tabIndex={0}
              onPointerDown={beginSplitResize}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  nudgeSplit(-0.03);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  nudgeSplit(0.03);
                }
              }}
            />
          )}
          <section
            ref={previewRef}
            className="presentation-preview"
            hidden={mode === "source"}
            onClick={onPreviewClick}
            onWheel={onPreviewWheel}
          >
            <div
              className="reveal"
              ref={revealRootRef}
              tabIndex={0}
              aria-label={t`Presentation preview`}
            >
              <div className="slides">
                {deck.slides.map((item, index) => {
                  const renderedSlide = renderedSlides[index];
                  return (
                    <section
                      className="presentation-slide-surface"
                      key={`${item.start}-${index}`}
                      data-layout={renderedSlide.layout}
                      dangerouslySetInnerHTML={{
                        __html: `<div class="presentation-slide-content">${renderedSlide.bodyHtml}</div><aside class="notes">${renderedSlide.notesHtml}</aside>`,
                      }}
                    />
                  );
                })}
              </div>
            </div>
            {mode !== "source" && (
              <div className="presentation-preview-navigation" aria-label={t`Slide navigation`}>
                <div className="presentation-preview-navigation-start">
                  <IconButton
                    className="presentation-preview-nav-button"
                    label={t`Previous slide`}
                    size="compact"
                    disabled={clampedSlide === 0}
                    onClick={() => navigate(slideRef.current - 1)}
                  >
                    <ChevronLeft />
                  </IconButton>
                  <IconButton
                    className="presentation-preview-nav-button"
                    label={t`Next slide`}
                    size="compact"
                    disabled={clampedSlide >= deck.slides.length - 1}
                    onClick={() => navigate(slideRef.current + 1)}
                  >
                    <ChevronRight />
                  </IconButton>
                </div>
                <label
                  className={`presentation-preview-page${slideEditing ? " editing" : ""}`}
                  title={t`Enter a slide number`}
                >
                  <input
                    aria-label={t`Slide number`}
                    inputMode="numeric"
                    value={slideEditing ? slideDraft : String(clampedSlide + 1)}
                    onFocus={(event) => {
                      const input = event.currentTarget;
                      cancelSlideEditRef.current = false;
                      setSlideEditing(true);
                      setSlideDraft(String(clampedSlide + 1));
                      window.requestAnimationFrame(() => input.select());
                    }}
                    onChange={(event) => {
                      if (/^\d*$/.test(event.target.value)) setSlideDraft(event.target.value);
                    }}
                    onBlur={commitSlideDraft}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        cancelSlideEditRef.current = true;
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </label>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default PresentationEditor;
