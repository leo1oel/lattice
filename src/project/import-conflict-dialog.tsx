import { useId } from "react";
import { useLingui } from "@lingui/react/macro";
import { FolderInput } from "lucide-react";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { ModalDialog } from "../components/ui/modal-dialog";
import { MotionButton } from "../components/ui/motion";
import type { ImportConflictRequest } from "../app/use-project-tree";

/** Names listed before the rest are counted. */
const LISTED_NAMES = 3;

/**
 * The one question an import asks: what to do with the names its target
 * folder already has, answered once for the whole batch. Each answer is its
 * own button, as Finder asks it: Keep both is the focused default (Enter), as
 * the answer that loses nothing; Replace, the one that overwrites, is drawn
 * in the danger ink; Escape or Cancel imports nothing. One name is named in
 * the title; several are listed under it. GPUI draws the same dialog
 * (gpui/crates/lattice-gpui/src/shell/import_conflict.rs).
 */
export default function ImportConflictDialog({ request }: { request: ImportConflictRequest }) {
  const { t } = useLingui();
  const descriptionId = useId();
  const { names, targetDirectory, answer } = request;
  const count = names.length;
  const [name] = names;
  const title = count === 1
    ? targetDirectory ? t`“${name}” is already in ${targetDirectory}` : t`“${name}” is already in the project root`
    : targetDirectory
      ? t`${count} items with these names are already in ${targetDirectory}`
      : t`${count} items with these names are already in the project root`;
  const hidden = count - LISTED_NAMES;
  return (
    <ModalDialog label={title} describedBy={descriptionId} onClose={() => answer(null)}>
      <div className="modal import-conflict-modal">
        <div className="modal-icon" data-tone="warning" aria-hidden="true"><FolderInput size={18} /></div>
        <h2>{title}</h2>
        <p id={descriptionId}>{t`Replace overwrites files of the same name and merges folders. Keep both imports a numbered copy.`}</p>
        {count > 1 && (
          <ul className="import-conflict-names">
            {names.slice(0, LISTED_NAMES).map((listed, index) => <li key={`${index}:${listed}`} title={listed}>{listed}</li>)}
            {hidden > 0 && <li className="import-conflict-more">{t`and ${hidden} more`}</li>}
          </ul>
        )}
        <div className="modal-actions">
          <Button variant="ghost" onClick={() => answer(null)}>{t`Cancel`}</Button>
          <Button variant="secondary" onClick={() => answer("skip")}>{t`Skip`}</Button>
          <Button variant="ghost" className="import-conflict-replace" onClick={() => answer("replace")}>{t`Replace`}</Button>
          <MotionButton autoFocus className={buttonClassName({ variant: "primary" })} onClick={() => answer("keepBoth")}>
            {t`Keep both`}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
