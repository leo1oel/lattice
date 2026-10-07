/**
 * Everything the app's Pierre diff surfaces share: the registered languages and
 * themes, the stylesheet that makes Pierre look like the rest of the app, the
 * resource preloading hook, and the diff metadata/CodeView settings. Kept out of
 * the component files so they stay Fast Refresh boundaries.
 */
import {
  areLanguagesAttached,
  areThemesAttached,
  getFiletypeFromFileName,
  isHighlighterLoaded,
  parseDiffFromFile,
  preloadHighlighter,
  registerCustomLanguage,
  registerCustomTheme,
  type FileDiffMetadata,
  type SupportedLanguages,
} from "@pierre/diffs";
import bibtex from "@shikijs/langs/bibtex";
import markdown from "@shikijs/langs/markdown";
import tex from "@shikijs/langs/tex";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import { useEffect, useMemo, useState } from "react";

/** One file's before/after text; a missing side means created or deleted. */
export type DiffFileChange = {
  path: string;
  before?: string | null;
  after?: string | null;
};

const PIERRE_THEMES = { light: "github-light", dark: "github-dark" } as const;

registerCustomLanguage("tex", () => Promise.resolve({ default: tex }));
registerCustomLanguage("bibtex", () => Promise.resolve({ default: bibtex }));
registerCustomLanguage("markdown", () => Promise.resolve({ default: markdown }));
registerCustomTheme(PIERRE_THEMES.light, () => Promise.resolve(githubLight));
registerCustomTheme(PIERRE_THEMES.dark, () => Promise.resolve(githubDark));

export function changeKind(before: string | null | undefined, after: string | null | undefined): "created" | "deleted" | "edited" {
  if (before == null && after != null) return "created";
  if (before != null && after == null) return "deleted";
  return "edited";
}

export function pierreLanguageForPath(path: string): SupportedLanguages {
  const language = getFiletypeFromFileName(path);
  return language === "tex" || language === "bibtex" || language === "markdown" ? language : "text";
}

/** Pierre's metadata for one change, typed as new/deleted when a side is missing. */
export function pierreFileDiff(change: DiffFileChange, lang: SupportedLanguages, cacheKey?: string): FileDiffMetadata {
  const side = (contents: string | null | undefined, suffix: string) => ({
    name: change.path,
    contents: contents ?? "",
    lang,
    ...(cacheKey ? { cacheKey: `${cacheKey}:${suffix}` } : {}),
  });
  const parsed = parseDiffFromFile(side(change.before, "before"), side(change.after, "after"));
  if (change.before == null) return { ...parsed, type: "new" };
  if (change.after == null) return { ...parsed, type: "deleted" };
  return parsed;
}

/** The unified, word-level CodeView layout every multi-file review uses. */
export function pierreCodeViewOptions(resources: { theme: "light" | "dark"; themeName: string }, gap: number) {
  return {
    diffStyle: "unified" as const,
    lineDiffType: "word" as const,
    overflow: "scroll" as const,
    stickyHeaders: true,
    theme: resources.themeName,
    themeType: resources.theme,
    unsafeCSS: PIERRE_UNSAFE_CSS,
    layout: { paddingTop: 0, paddingBottom: gap, gap },
  };
}

/** Index of the last item whose top has scrolled past `scrollTop`: the one being read. */
export function topVisibleIndex(
  ids: readonly string[],
  scrollTop: number,
  viewer: { getTopForItem: (id: string) => number | undefined },
): number {
  let visible = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const top = viewer.getTopForItem(ids[index]!);
    if (top == null) continue;
    if (top > scrollTop + 1) break;
    visible = index;
  }
  return visible;
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
  font-weight: var(--type-micro-weight) !important;
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

export function usePierreResources(path: string | readonly string[]) {
  const [theme, setTheme] = useState(currentTheme);
  const themeName = PIERRE_THEMES[theme];
  const languages = useMemo(
    () => [...new Set((typeof path === "string" ? [path] : path).map(pierreLanguageForPath))],
    [path],
  );
  const preloadKey = `${themeName}:${languages.join(",")}`;
  const [loadResult, setLoadResult] = useState<{ key: string; error?: Error } | null>(null);
  const ready = (loadResult?.key === preloadKey && loadResult.error == null) || (
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
      () => { if (active) setLoadResult({ key: preloadKey }); },
      (cause: unknown) => {
        if (active) setLoadResult({ key: preloadKey, error: cause instanceof Error ? cause : new Error(String(cause)) });
      },
    );
    return () => { active = false; };
  }, [languages, preloadKey, ready, themeName]);

  return {
    error: loadResult?.key === preloadKey ? loadResult.error : undefined,
    language: languages[0] ?? "text",
    preloadKey,
    ready,
    theme,
    themeName,
  };
}
