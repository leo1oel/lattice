import {
  areLanguagesAttached,
  areThemesAttached,
  getFiletypeFromFileName,
  isHighlighterLoaded,
  parseDiffFromFile,
  preloadHighlighter,
} from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import { InfinityLoader } from "./components/ui/activity-icons";

export type FileDiffChange = {
  path: string;
  before?: string | null;
  after?: string | null;
};

const THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

const unsafeCss = `
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
  * {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--text-primary) 8%, transparent) transparent;
  }

  *::-webkit-scrollbar { width: 10px; height: 10px; }
  *::-webkit-scrollbar-track,
  *::-webkit-scrollbar-corner { background: transparent; }
  *::-webkit-scrollbar-thumb {
    border: 3px solid transparent;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-primary) 8%, transparent);
    background-clip: content-box;
  }
  *::-webkit-scrollbar-thumb:vertical { border-right-width: 5px; border-left-width: 1px; }
  *::-webkit-scrollbar-thumb:horizontal { border-top-width: 1px; border-bottom-width: 5px; }
  *::-webkit-scrollbar-thumb:hover { background-color: color-mix(in srgb, var(--text-primary) 12%, transparent); }
  *::-webkit-scrollbar-thumb:vertical:hover { border-right-width: 4px; border-left-width: 0; }
  *::-webkit-scrollbar-thumb:horizontal:hover { border-top-width: 0; border-bottom-width: 4px; }
  *::-webkit-scrollbar-thumb:active { background-color: color-mix(in srgb, var(--text-primary) 16%, transparent); }
}
`;

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function useDocumentTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(currentTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function metadataFor(change: FileDiffChange): FileDiffMetadata {
  const before = change.before ?? "";
  const after = change.after ?? "";
  const parsed = parseDiffFromFile(
    { name: change.path, contents: before },
    { name: change.path, contents: after },
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
  const theme = useDocumentTheme();
  const themeName = THEMES[theme];
  const language = getFiletypeFromFileName(path);
  const preloadKey = `${themeName}:${language}`;
  const [loadResult, setLoadResult] = useState<{ key: string; error?: Error } | null>(null);
  const fileDiff = useMemo(
    () => metadataFor({ path, before, after }),
    [after, before, path],
  );
  const resourcesReady =
    isHighlighterLoaded() && areThemesAttached(themeName) && areLanguagesAttached(language);

  useEffect(() => {
    if (resourcesReady) return;
    let active = true;
    void preloadHighlighter({ themes: [themeName], langs: [language] }).then(
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
  }, [language, preloadKey, resourcesReady, themeName]);

  if (before === after) {
    return <p className="lattice-file-diff-empty">No textual changes.</p>;
  }
  if ((before == null && after === "") || (after == null && before === "")) {
    return <p className="lattice-file-diff-empty">Empty file {before == null ? "added" : "deleted"}.</p>;
  }
  if (loadResult?.key === preloadKey && loadResult.error) {
    return <p className="lattice-file-diff-error" role="alert">Could not render this diff: {loadResult.error.message}</p>;
  }
  if (!resourcesReady) {
    return <p className="lattice-file-diff-loading" role="status"><InfinityLoader size={12} /> Rendering diff…</p>;
  }

  return (
    <FileDiff
      key={`${preloadKey}:${path}:${before?.length ?? -1}:${after?.length ?? -1}`}
      fileDiff={fileDiff}
      options={{
        diffStyle: "unified",
        lineDiffType: "word",
        overflow: "scroll",
        theme: themeName,
        themeType: theme,
        unsafeCSS: unsafeCss,
        disableFileHeader: true,
        onLineClick: props.onOpenLine
          ? ({ lineNumber }) => props.onOpenLine?.(path, lineNumber)
          : undefined,
      }}
      disableWorkerPool
    />
  );
}
