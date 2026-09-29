import { FileDiff } from "@pierre/diffs/react";
import { useLingui } from "@lingui/react/macro";
import { FilePen, FilePlus2, FileX2, MoveRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";
import { changeKind, PIERRE_UNSAFE_CSS, pierreFileDiff, usePierreResources, type DiffFileChange } from "./pierre-diff";

/**
 * A plain, non-virtualized Pierre file diff.
 * Single-file history surfaces already live inside a scrollable drawer, so a
 * second virtualizer creates stale WebKit offsets and large blank regions.
 */
export function FileDiffView(props: {
  change: DiffFileChange;
  onOpenLine?: (path: string, line: number) => void;
}) {
  const { after, before, path } = props.change;
  const { t } = useLingui();
  const resources = usePierreResources(path);
  const fileDiff = useMemo(
    () => pierreFileDiff({ path, before, after }, resources.language),
    [after, before, path, resources.language],
  );

  if (before === after) {
    return <p className="lattice-file-diff-empty">{t`No textual changes`}</p>;
  }
  if ((before == null && after === "") || (after == null && before === "")) {
    return <p className="lattice-file-diff-empty">{before == null ? t`Empty file added` : t`Empty file deleted`}</p>;
  }
  if (resources.error) {
    const errorMessage = resources.error.message;
    return <InlineMessage level="error" className="lattice-file-diff-inline">{t`Could not render this diff: ${errorMessage}`}</InlineMessage>;
  }
  if (!resources.ready) {
    return <p className="lattice-file-diff-loading" role="status"><InfinityLoader size={12} /> {t`Rendering diff…`}</p>;
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

/** "created" / "deleted" / "edited", translated. */
export function ChangeKindLabel(props: { change: DiffFileChange }) {
  const { t } = useLingui();
  const labels = { created: t`created`, deleted: t`deleted`, edited: t`edited` };
  return <>{labels[changeKind(props.change.before, props.change.after)]}</>;
}

/**
 * One file's diff under a path header, shared by the Changes, Versions and
 * Overleaf history tabs. A binary change has no text to diff, so it gets a
 * notice in the same frame instead.
 */
export function HistoryDiff(props: {
  change: DiffFileChange;
  binary?: boolean;
  onOpenLine?: (path: string, line: number) => void;
  headerAction?: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <div className="history-diff">
      <div className="history-diff-meta">
        <strong>{props.change.path}</strong>
        <span>{props.binary ? t`binary` : <ChangeKindLabel change={props.change} />}</span>
        {props.headerAction}
      </div>
      {props.binary ? <p className="versions-binary">{t`Binary file changed`}</p> : (
        <div className="lattice-file-diff-body" aria-label={t`Diff for ${props.change.path}`}>
          <FileDiffView change={props.change} onOpenLine={props.onOpenLine} />
        </div>
      )}
    </div>
  );
}

const FILE_KIND_ICONS = {
  added: FilePlus2,
  deleted: FileX2,
  removed: FileX2,
  renamed: MoveRight,
  modified: FilePen,
  edited: FilePen,
};

/** The added/deleted/renamed/edited glyph beside a file in a version's file list. */
export function FileKindIcon(props: { kind: keyof typeof FILE_KIND_ICONS }) {
  const Icon = FILE_KIND_ICONS[props.kind] ?? FilePen;
  return <Icon size={12} className={`versions-kind ${props.kind}`} aria-hidden />;
}
