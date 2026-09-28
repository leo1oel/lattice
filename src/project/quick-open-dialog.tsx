import { useMemo } from "react";
import { PickerDialog, rankMatches, subsequenceScore } from "../components/ui/search-picker-dialog";

function scorePath(path: string, query: string): number {
  const hay = path.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return 1;
  if (hay === needle) return 1000;
  if (hay.endsWith(`/${needle}`)) return 900;
  if (hay.includes(needle)) return 500 - hay.indexOf(needle);
  return subsequenceScore(hay, needle);
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
  const rank = useMemo(() => (query: string) => rankMatches(
    paths,
    (path) => scorePath(path, query),
    (left, right) => left.localeCompare(right),
    40,
  ), [paths]);
  return (
    <PickerDialog
      {...props}
      label="Quick open file"
      searchLabel="Quick open search"
      placeholder="Open file…"
      closeLabel="Close quick search"
      compactClose
      emptyText="No matching files"
      rank={rank}
      itemKey={(path) => path}
      renderItem={(path) => path}
      onSelect={onOpen}
    />
  );
}
