import { useId, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { FolderInput } from "lucide-react";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { ModalDialog } from "../components/ui/modal-dialog";
import { MotionButton } from "../components/ui/motion";
import { RadioGroup, RadioItem } from "../components/ui/radio-group";
import type { ImportConflictRequest, NameConflict } from "../app/use-project-tree";

/** Names listed before the rest are counted. */
const LISTED_NAMES = 3;
const CHOICES: readonly NameConflict[] = ["keepBoth", "replace", "skip"];

/**
 * The one question an import asks: what to do with the names its target
 * folder already has, answered once for the whole batch. Keep both is chosen
 * first, as the answer that loses nothing; Escape or Cancel imports nothing.
 * Lazily loaded: the radio group brings Motion with it.
 */
export default function ImportConflictDialog({ request }: { request: ImportConflictRequest }) {
  const { t } = useLingui();
  const descriptionId = useId();
  const [choice, setChoice] = useState<NameConflict>("keepBoth");
  const { names, targetDirectory, answer } = request;
  const count = names.length;
  // The title names the folder, so the list under it is the names alone.
  const title = targetDirectory
    ? count === 1 ? t`An item with this name is already in ${targetDirectory}` : t`${count} items with these names are already in ${targetDirectory}`
    : count === 1 ? t`An item with this name is already in the project root` : t`${count} items with these names are already in the project root`;
  // Only Replace says more than its label: it overwrites, and merges folders.
  const presentations: Record<NameConflict, { label: string; description?: string }> = {
    keepBoth: { label: t`Keep both` },
    replace: { label: t`Replace`, description: t`Overwrite files of the same name; merge folders` },
    skip: { label: t`Skip` },
  };
  const hidden = count - LISTED_NAMES;
  return (
    <ModalDialog label={title} describedBy={descriptionId} onClose={() => answer(null)}>
      <div className="modal import-conflict-modal">
        <div className="modal-icon" data-tone="warning" aria-hidden="true"><FolderInput size={18} /></div>
        <h2>{title}</h2>
        <div id={descriptionId} className="import-conflict-names">
          <ul>
            {names.slice(0, LISTED_NAMES).map((name, index) => <li key={`${index}:${name}`} title={name}>{name}</li>)}
            {hidden > 0 && <li className="import-conflict-more">{t`and ${hidden} more`}</li>}
          </ul>
        </div>
        <RadioGroup selectedIndex={CHOICES.indexOf(choice)} aria-label={t`For each item already here`}>
          {CHOICES.map((value, index) => (
            <div key={value} className="import-conflict-option">
              <RadioItem
                index={index}
                label={presentations[value].label}
                onSelect={() => setChoice(value)}
                aria-describedby={presentations[value].description ? `${descriptionId}-${value}` : undefined}
                className="import-conflict-radio"
              />
              {presentations[value].description && (
                <small id={`${descriptionId}-${value}`} className="import-conflict-description">
                  {presentations[value].description}
                </small>
              )}
            </div>
          ))}
        </RadioGroup>
        <div className="modal-actions">
          <Button variant="ghost" onClick={() => answer(null)}>{t`Cancel`}</Button>
          <MotionButton className={buttonClassName({ variant: "primary" })} onClick={() => answer(choice)}>
            {t`Import`}
          </MotionButton>
        </div>
      </div>
    </ModalDialog>
  );
}
