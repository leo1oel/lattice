import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { rankMatches, scorePath } from "../components/ui/picker-ranking";
import { PickerDialog } from "../components/ui/search-picker-dialog";
import { isProjectAssetFilePath } from "../app-utils";
import { fileIcon } from "../trellis/trellis-icons";

/** The file's name first, where the eye looks, and its folder after it, quieter. */
function PathRow({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="picker-file">
      <span className="picker-file-icon">{fileIcon(path, isProjectAssetFilePath(path) ? "asset" : "file")}</span>
      <span className="picker-file-name">{path.slice(slash + 1)}</span>
      {slash > 0 && <span className="picker-file-folder">{path.slice(0, slash)}</span>}
    </span>
  );
}

type QuickOpenProps = {
  paths: string[];
  onClose: () => void;
  onOpen: (path: string) => void;
  onIntent?: (path: string) => void;
};

/** Unmounting the form while closed resets its query and highlight. */
export function QuickOpenDialog({ open, ...props }: QuickOpenProps & { open: boolean }) {
  return open ? <QuickOpenDialogForm {...props} /> : null;
}

function QuickOpenDialogForm({ paths, onOpen, ...props }: QuickOpenProps) {
  const { t } = useLingui();
  const rank = useMemo(() => (query: string) => rankMatches(
    paths,
    (path) => scorePath(path, query),
    (left, right) => left.localeCompare(right),
    40,
  ), [paths]);
  return (
    <PickerDialog
      {...props}
      label={t`Quick open file`}
      searchLabel={t`Quick open search`}
      placeholder={t`Open file…`}
      closeLabel={t`Close quick search`}
      compactClose
      emptyText={t`No matching files`}
      rank={rank}
      itemKey={(path) => path}
      itemLabel={(path) => path}
      renderItem={(path) => <PathRow path={path} />}
      onSelect={onOpen}
    />
  );
}
