/**
 * Local seam — not upstream code.
 *
 * Stands in for the `next-themes` package (vendor rewrite in
 * scripts/vendor-open-knowledge.mjs). Upstream resolves the app theme via
 * next-themes' ThemeProvider; this host toggles `:root[data-theme]`
 * (src/styles/theme.css), so `useTheme` derives the same shape from that
 * attribute and re-renders when it flips.
 */
import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function useTheme(): {
  theme: Theme;
  resolvedTheme: Theme;
  setTheme: (theme: string) => void;
} {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "light" as Theme);
  return {
    theme,
    resolvedTheme: theme,
    // The host owns theme switching (settings dialog); vendored code never
    // calls this in practice.
    setTheme: () => {},
  };
}
