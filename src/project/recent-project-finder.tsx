/**
 * The recent-project finder: every recent project the app keeps (a hundred),
 * searched by name and folder on quick open's card. The title's switcher,
 * File ▸ Open Recent and the welcome screen list only the newest few and end
 * in a way here, so an older project is a search away rather than a second
 * download from Overleaf. Each row says when the folder is linked to
 * Overleaf, and when it was not there at the last look.
 */
import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { PickerDialog } from "../components/ui/search-picker-dialog";
import { rankMatches, scoreItem } from "../components/ui/picker-ranking";
import type { RecentProject } from "../settings/app-settings";
import { otherProjects } from "./first-pages";
import { parentFolderLabel } from "./recent-project-labels";
import { RecentProjectBadge, RecentProjectIcon } from "./welcome-recent-list";

type Row = { project: RecentProject; label: string; detail: string; keywords: string; order: number };

export function RecentProjectFinder(props: {
  projects: readonly RecentProject[];
  currentPath: string | undefined;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  const { t } = useLingui();
  const rows = useMemo(() => otherProjects(props.projects, props.currentPath).map((project, order): Row => ({
    project, order, label: project.name, detail: parentFolderLabel(project.path), keywords: project.path,
  })), [props.projects, props.currentPath]);
  // An empty query lists them newest first; a typed one ranks, newer first among equals.
  const rank = useMemo(() => (query: string) => (
    query ? rankMatches(rows, (row) => scoreItem(row, query), (left, right) => left.order - right.order, rows.length) : rows
  ), [rows]);
  return (
    <PickerDialog<Row>
      label={t`Open a recent project`}
      searchLabel={t`Search recent projects`}
      placeholder={t`Open a recent project…`}
      detailPlacement="end"
      emptyText={t`No recent projects`}
      noMatch={(query) => ({ title: t`No recent project matches “${query}”` })}
      rank={rank}
      itemKey={(row) => row.project.path}
      itemLabel={(row) => row.label}
      renderItem={(row) => (
        <>
          <span className="picker-icon" aria-hidden="true"><RecentProjectIcon project={row.project} size={14} /></span>
          <span className="picker-text" data-missing={row.project.missing || undefined}>
            <span className="picker-label">{row.label}</span>
            <em className="picker-detail" title={row.project.path}>{row.detail}</em>
          </span>
          <RecentProjectBadge project={row.project} />
        </>
      )}
      className="recent-project-finder"
      onClose={props.onClose}
      onSelect={(row) => {
        props.onClose();
        props.onOpen(row.project.path);
      }}
    />
  );
}
