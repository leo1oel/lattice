import {
  areLanguagesAttached,
  areThemesAttached,
  getFiletypeFromFileName,
  isHighlighterLoaded,
  parseDiffFromFile,
  preloadHighlighter,
  registerCustomLanguage,
  registerCustomTheme,
  type SupportedLanguages,
} from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import bibtex from "@shikijs/langs/bibtex";
import markdown from "@shikijs/langs/markdown";
import tex from "@shikijs/langs/tex";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import { useEffect, useMemo, useState } from "react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";

export type FileDiffChange = {
  path: string;
  before?: string | null;
  after?: string | null;
};

// Shared by every Pierre surface; React components remain the only stateful exports.
const PIERRE_THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

registerCustomLanguage("tex", () => Promise.resolve({ default: tex }));
registerCustomLanguage("bibtex", () => Promise.resolve({ default: bibtex }));
registerCustomLanguage("markdown", () => Promise.resolve({ default: markdown }));
registerCustomTheme(PIERRE_THEMES.light, () => Promise.resolve(githubLight));
registerCustomTheme(PIERRE_THEMES.dark, () => Promise.resolve(githubDark));

// eslint-disable-next-line react-refresh/only-export-components
export function pierreLanguageForPath(path: string): SupportedLanguages {
  const language = getFiletypeFromFileName(path);
  return language === "tex" || language === "bibtex" || language === "markdown"
    ? language
    : "text";
}

export const PIERRE_UNSAFE_CSS = `
:host {
  --diffs-font-family: var(--editor-font);
  --diffs-header-font-family: var(--ui-font);
  --diffs-font-size: var(--type-diff-code-size);
  --diffs-line-height: var(--type-diff-code-line-height);
  --diffs-overflow-override: auto;
  --diffs-bg: var(--surface-app) !important;
  --diffs-light-bg: var(--surface-app) !important;
  --diffs-dark-bg: var(--surface-app) !important;
  --diffs-bg-context-override: var(--surface-app) !important;
  --diffs-bg-context-number-override: var(--surface-app) !important;
  --diffs-bg-hover-override: color-mix(in srgb, var(--surface-app) 96%, var(--text-primary)) !important;
  --diffs-bg-separator-override: color-mix(in srgb, var(--surface-app) 95%, var(--text-primary)) !important;
  --diffs-bg-buffer-override: color-mix(in srgb, var(--surface-app) 93%, var(--text-primary)) !important;
  --diffs-bg-addition-override: color-mix(in srgb, var(--surface-app) 88%, var(--status-success)) !important;
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--surface-app) 84%, var(--status-success)) !important;
  --diffs-bg-deletion-override: color-mix(in srgb, var(--surface-app) 89%, var(--status-danger)) !important;
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--surface-app) 85%, var(--status-danger)) !important;
  background: var(--surface-app) !important;
  font-family: var(--editor-font) !important;
  font-size: var(--type-diff-code-size) !important;
  line-height: var(--type-diff-code-line-height) !important;
}

[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: var(--surface-app) !important;
  --diffs-light-bg: var(--surface-app) !important;
  --diffs-dark-bg: var(--surface-app) !important;
  background: var(--surface-app) !important;
  font-family: var(--editor-font) !important;
  font-size: var(--type-diff-code-size) !important;
  line-height: var(--type-diff-code-line-height) !important;
}

[data-line-number-content],
[data-column-number],
[data-unmodified-lines] {
  font-family: var(--ui-font) !important;
  font-size: var(--type-diff-meta-size) !important;
  line-height: var(--type-diff-code-line-height) !important;
  font-weight: var(--type-diff-meta-weight) !important;
  font-variant-numeric: tabular-nums !important;
}

@media (pointer: fine) {
  [data-code],
  [data-error-wrapper] {
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
  }

  [data-code]:hover,
  [data-error-wrapper]:hover {
    scrollbar-color: color-mix(in srgb, var(--text-primary) 12%, transparent) transparent;
  }

  [data-code]::-webkit-scrollbar,
  [data-error-wrapper]::-webkit-scrollbar {
    width: 10px !important;
    height: 10px !important;
  }

  [data-code]::-webkit-scrollbar-track,
  [data-code]::-webkit-scrollbar-corner,
  [data-error-wrapper]::-webkit-scrollbar-track,
  [data-error-wrapper]::-webkit-scrollbar-corner {
    background: transparent !important;
  }

  [data-code]::-webkit-scrollbar-thumb,
  [data-error-wrapper]::-webkit-scrollbar-thumb {
    border: 3px solid transparent;
    border-radius: var(--radius-pill);
    background: transparent !important;
    background-clip: content-box;
  }

  [data-code]::-webkit-scrollbar-thumb:vertical,
  [data-error-wrapper]::-webkit-scrollbar-thumb:vertical {
    border-right-width: 5px;
    border-left-width: 1px;
  }

  [data-code]::-webkit-scrollbar-thumb:horizontal,
  [data-error-wrapper]::-webkit-scrollbar-thumb:horizontal {
    border-top-width: 1px;
    border-bottom-width: 5px;
  }

  [data-code]:hover::-webkit-scrollbar-thumb,
  [data-error-wrapper]:hover::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--text-primary) 12%, transparent) !important;
    background-clip: content-box;
  }

  [data-code]:hover::-webkit-scrollbar-thumb:vertical,
  [data-error-wrapper]:hover::-webkit-scrollbar-thumb:vertical {
    border-right-width: 4px;
    border-left-width: 0;
  }

  [data-code]:hover::-webkit-scrollbar-thumb:horizontal,
  [data-error-wrapper]:hover::-webkit-scrollbar-thumb:horizontal {
    border-top-width: 0;
    border-bottom-width: 4px;
  }

  [data-code]::-webkit-scrollbar-thumb:active,
  [data-error-wrapper]::-webkit-scrollbar-thumb:active {
    background: color-mix(in srgb, var(--text-primary) 18%, transparent) !important;
    background-clip: padding-box;
  }
}
`;

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePierreResources(path: string | readonly string[]) {
  const [theme, setTheme] = useState(currentTheme);
  const themeName = PIERRE_THEMES[theme];
  const languages = useMemo(
    () => [...new Set((typeof path === "string" ? [path] : path).map(pierreLanguageForPath))],
    [path],
  );
  const language = languages[0] ?? "text";
  const languageKey = languages.join(",");
  const preloadKey = `${themeName}:${languageKey}`;
  const [loadResult, setLoadResult] = useState<{ key: string; error?: Error } | null>(null);
  const preloadSucceeded = loadResult?.key === preloadKey && loadResult.error == null;
  const ready = preloadSucceeded || (
    isHighlighterLoaded()
    && areThemesAttached(themeName)
    && languages.every((candidate) => areLanguagesAttached(candidate))
  );

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (ready) return;
    let active = true;
    void preloadHighlighter({ themes: [themeName], langs: languages }).then(
      () => {
        if (active) setLoadResult({ key: preloadKey });
      },
      (cause: unknown) => {
        if (!active) return;
        setLoadResult({
          key: preloadKey,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      },
    );
    return () => {
      active = false;
    };
  }, [languages, preloadKey, ready, themeName]);

  return {
    error: loadResult?.key === preloadKey ? loadResult.error : undefined,
    language,
    languages,
    preloadKey,
    ready,
    theme,
    themeName,
  };
}

function metadataFor(change: FileDiffChange, language: SupportedLanguages): FileDiffMetadata {
  const before = change.before ?? "";
  const after = change.after ?? "";
  const parsed = parseDiffFromFile(
    { name: change.path, contents: before, lang: language },
    { name: change.path, contents: after, lang: language },
  );
  if (change.before == null) return { ...parsed, type: "new" };
  if (change.after == null) return { ...parsed, type: "deleted" };
  return parsed;
}

/**
 * A plain, non-virtualized Pierre file diff.
 * Single-file history surfaces already live inside a scrollable drawer, so a
 * second virtualizer creates stale WebKit offsets and large blank regions.
 */
export function FileDiffView(props: {
  change: FileDiffChange;
  onOpenLine?: (path: string, line: number) => void;
}) {
  const { after, before, path } = props.change;
  const resources = usePierreResources(path);
  const fileDiff = useMemo(
    () => metadataFor({ path, before, after }, resources.language),
    [after, before, path, resources.language],
  );

  if (before === after) {
    return <p className="lattice-file-diff-empty">No textual changes</p>;
  }
  if ((before == null && after === "") || (after == null && before === "")) {
    return <p className="lattice-file-diff-empty">Empty file {before == null ? "added" : "deleted"}</p>;
  }
  if (resources.error) {
    return <InlineMessage level="error" className="lattice-file-diff-inline">Could not render this diff: {resources.error.message}</InlineMessage>;
  }
  if (!resources.ready) {
    return <p className="lattice-file-diff-loading" role="status"><InfinityLoader size={12} /> Rendering diff…</p>;
  }

  return (
    <FileDiff
      key={`${resources.preloadKey}:${path}:${before?.length ?? -1}:${after?.length ?? -1}`}
      fileDiff={fileDiff}
      options={{
        diffStyle: "unified",
        lineDiffType: "word",
        overflow: "scroll",
        theme: resources.themeName,
        themeType: resources.theme,
        unsafeCSS: PIERRE_UNSAFE_CSS,
        disableFileHeader: true,
        onLineClick: props.onOpenLine
          ? ({ lineNumber }) => props.onOpenLine?.(path, lineNumber)
          : undefined,
      }}
      disableWorkerPool
    />
  );
}
