import { useEffect, useState, type CSSProperties } from "react";
import { useLingui } from "@lingui/react/macro";
import { FileText } from "lucide-react";
import { Badge } from "../components/ui/badge";
import type { RecentProject } from "../settings/app-settings";
import { loadFirstPages } from "./first-pages";

/** Where a project lives, as a writer reads it: its parent folder, home written as ~. */
function parentFolderLabel(path: string) {
  const parent = path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
  return parent.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

type ShownPage = { url: string; venue: string | null; editedAt: number | null };

/**
 * Each project's stored first page as an image URL, null until they are read.
 * Reading is a few small images, so a project with none shows its card at
 * once rather than after a placeholder.
 */
function useFirstPages(paths: readonly string[]) {
  const key = paths.join("\n");
  const [pages, setPages] = useState<{ key: string; pages: Map<string, ShownPage>; now: number } | null>(null);
  useEffect(() => {
    let disposed = false;
    const urls: string[] = [];
    void loadFirstPages(key ? key.split("\n") : []).catch(() => new Map()).then((found) => {
      if (disposed) return;
      const shown = new Map<string, ShownPage>();
      for (const [path, page] of found) {
        const url = URL.createObjectURL(page.image);
        urls.push(url);
        shown.set(path, { url, venue: page.venue, editedAt: page.editedAt });
      }
      // Ages are read against when the desk was laid out, not each render.
      setPages({ key, pages: shown, now: Date.now() });
    });
    return () => {
      disposed = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [key]);
  return pages?.key === key ? pages : null;
}

/** "yesterday", "3 days ago", "last month": how long before `now` a moment was. */
function age(then: number, now: number, locale: string, justNow: string): string {
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const days = seconds / 86_400;
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (days < 1) return format.format(-Math.round(seconds / 3600), "hour");
  if (days < 7) return format.format(-Math.round(days), "day");
  if (days < 30) return format.format(-Math.round(days / 7), "week");
  if (days < 365) return format.format(-Math.round(days / 30), "month");
  return format.format(-Math.round(days / 365), "year");
}

/**
 * The recent projects as the first page of each paper, like drafts on a desk:
 * the page a build last wrote with its venue on it, the name in the title
 * serif, and when it last changed. A project that has not built a PDF yet
 * shows a plain card with a page glyph.
 */
export function WelcomeDesk(props: {
  projects: readonly RecentProject[];
  disabled: boolean;
  onOpen: (path: string) => void;
}) {
  const { t, i18n } = useLingui();
  const loaded = useFirstPages(props.projects.map((item) => item.path));
  const pages = loaded?.pages ?? null;
  const when = (item: RecentProject, page: ShownPage | undefined, now: number) => {
    const justNow = t`just now`;
    if (page?.editedAt) {
      const edited = age(page.editedAt, now, i18n.locale, justNow);
      return t({ message: `Edited ${edited}`, comment: "A recent project's last change: “Edited yesterday”, “Edited 3 days ago”." });
    }
    if (typeof item.openedAt === "number") {
      const opened = age(item.openedAt, now, i18n.locale, justNow);
      return t({ message: `Opened ${opened}`, comment: "When a recent project was last opened: “Opened yesterday”, “Opened 3 days ago”." });
    }
    return parentFolderLabel(item.path);
  };
  const last = props.projects.length;
  return (
    <div className="welcome-desk-frame" style={{ "--desk-count": last } as CSSProperties}>
      <h2 className="welcome-recents-title">{t`Recent projects`}</h2>
      <ul className="welcome-desk">
        {props.projects.map((item, index) => {
          const page = pages?.get(item.path);
          return (
            <li key={item.path}>
              <button
                type="button"
                className="welcome-desk-card"
                // Its key shows only here and in the ⌘? sheet; assistive
                // technology reads it from aria-keyshortcuts.
                title={`${item.path} · ⌘${index + 1}`}
                aria-keyshortcuts={`Meta+${index + 1}`}
                disabled={props.disabled}
                onClick={() => props.onOpen(item.path)}
              >
                {/* Read first by assistive technology, drawn under the page. */}
                <span className="welcome-desk-name">{item.name}</span>
                <span className="welcome-desk-when">{loaded && when(item, page, loaded.now)}</span>
                {page ? (
                  <span className="welcome-desk-sheet" data-kind="page">
                    <img src={page.url} alt="" draggable={false} />
                    {page.venue && <Badge size="compact" className="welcome-desk-venue">{page.venue}</Badge>}
                  </span>
                ) : (
                  <span className="welcome-desk-sheet" data-kind={pages ? "notes" : "loading"}>
                    {pages && <FileText size={20} strokeWidth={1.5} aria-hidden="true" />}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
