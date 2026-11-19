import { useReducer, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Cloud, Folder, Search } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { ScrollArea } from "../components/ui/scroll-area";
import type { RecentProject } from "../settings/app-settings";
import { age, parentFolderLabel } from "./recent-project-labels";

/** The badge a recent project's row ends in: missing before linked, as a missing folder opens nothing. */
export function RecentProjectBadge({ project }: { project: RecentProject }): ReactNode {
  const { t } = useLingui();
  if (project.missing) return <Badge size="compact" tone="warning" title={t`Its folder was not found`}>{t`Missing`}</Badge>;
  if (project.overleaf) return <Badge size="compact" title={t`Linked to an Overleaf project`}>{t`Overleaf`}</Badge>;
  return null;
}

/** A cloud for a project linked to Overleaf, a folder for any other. */
export function RecentProjectIcon({ project, size }: { project: RecentProject; size: number }) {
  return project.overleaf ? <Cloud size={size} /> : <Folder size={size} />;
}

/**
 * The welcome screen's list under its desk: the next recent projects, one
 * compact row each (its folder, whether it is linked to Overleaf or missing,
 * when it was last opened) in a box that scrolls, then "Show all", the
 * finder over every recent project.
 */
/** How many the list shows before "Show all". */
const LISTED = 20;

export function WelcomeRecentList(props: {
  /** The recent projects after the desk's, newest first. */
  projects: readonly RecentProject[];
  /** Every recent project the finder would search, for "Show all"'s count. */
  total: number;
  disabled: boolean;
  onOpen: (path: string) => void;
  onShowAll: () => void;
}) {
  const { t, i18n } = useLingui();
  // Ages are read against when the list was laid out, not each render.
  const [now] = useReducer((at: number) => at, undefined, Date.now);
  const total = props.total;
  return (
    <div className="welcome-recent-list-frame">
      <h2 className="welcome-recents-title">{t`More projects`}</h2>
      <ScrollArea viewportClassName="welcome-recent-list-viewport">
        <ul className="welcome-recent-list">
          {props.projects.slice(0, LISTED).map((item) => (
            <li key={item.path}>
              <button
                type="button"
                className="welcome-recent-row"
                data-missing={item.missing || undefined}
                title={item.path}
                disabled={props.disabled}
                onClick={() => props.onOpen(item.path)}
              >
                <span className="welcome-recent-icon" aria-hidden="true"><RecentProjectIcon project={item} size={14} /></span>
                <span className="welcome-recent-name">{item.name}</span>
                <span className="welcome-recent-folder">{parentFolderLabel(item.path)}</span>
                <RecentProjectBadge project={item} />
                {typeof item.openedAt === "number" && (
                  <span className="welcome-recent-when">{age(item.openedAt, now, i18n.locale, t`just now`)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
      {props.projects.length > LISTED && (
        <button type="button" className="welcome-more-action welcome-recent-all" onClick={props.onShowAll}>
          <Search size={15} /> {t`Show all ${total} projects`}
        </button>
      )}
    </div>
  );
}
