import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { CircleAlert, Trash2 } from "lucide-react";
import {
  registerConfirmActionHandler,
  type ConfirmActionChoice,
  type ConfirmActionOptions,
} from "../../app-utils";
import { ModalDialog } from "./modal-dialog";
import { Button } from "./button";
import { buttonClassName } from "./button-styles";
import { DestructiveButton } from "./destructive-button";
import { MotionButton, PopIn } from "./motion";

type PendingConfirmation = {
  id: number;
  options: ConfirmActionOptions;
  resolve: (answer: ConfirmActionChoice) => void;
};

let nextConfirmationId = 1;

function firstQuestion(message: string): { title: string | null; description: string } {
  const question = message.indexOf("?");
  if (question < 0 || question > 96) return { title: null, description: message };
  const title = message.slice(0, question + 1).trim();
  const description = message.slice(question + 1).trim();
  return { title, description };
}

function confirmationCopy(options: ConfirmActionOptions, defaults: {
  deleteTitle: string;
  continueTitle: string;
  deleteLabel: string;
  removeLabel: string;
  restoreLabel: string;
  continueLabel: string;
  destructiveDescription: string;
  continueDescription: string;
}): {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
} {
  const split = firstQuestion(options.message.trim());
  const title = options.title
    ?? split.title
    ?? (/^\s*(delete|remove)\b/i.test(options.message) ? defaults.deleteTitle : defaults.continueTitle);
  const destructive = options.destructive
    ?? /\b(delete|remove|discard|overwrite|cannot be undone)\b/i.test(options.message);
  const confirmLabel = options.confirmLabel
    ?? (/^delete\b/i.test(title)
      ? defaults.deleteLabel
      : /^remove\b/i.test(title)
        ? defaults.removeLabel
        : /^restore\b/i.test(title)
          ? defaults.restoreLabel
          : defaults.continueLabel);
  let description = split.description;
  if (!description && options.message !== title) description = options.message;
  if (!description) {
    description = destructive
      ? defaults.destructiveDescription
      : defaults.continueDescription;
  }
  description = description.replace(/[.。]$/, "");
  return { title, description, confirmLabel, destructive };
}

export function ConfirmActionProvider({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const descriptionId = useId();
  const [queue, setQueue] = useState<PendingConfirmation[]>([]);
  const current = queue[0] ?? null;

  useEffect(() => registerConfirmActionHandler((options) => new Promise<ConfirmActionChoice>((resolve) => {
    setQueue((items) => [
      ...items,
      { id: nextConfirmationId++, options, resolve },
    ]);
  })), []);

  const settle = useCallback((answer: ConfirmActionChoice) => {
    if (!current) return;
    current.resolve(answer);
    setQueue((items) => (
      items[0]?.id === current.id ? items.slice(1) : items
    ));
  }, [current]);

  const copy = current ? confirmationCopy(current.options, {
    deleteTitle: t`Delete this item?`,
    continueTitle: t`Continue?`,
    deleteLabel: t`Delete`,
    removeLabel: t`Remove`,
    restoreLabel: t`Restore`,
    continueLabel: t`Continue`,
    destructiveDescription: t`This action cannot be undone.`,
    continueDescription: t`Please confirm that you want to continue.`,
  }) : null;

  return (
    <>
      {children}
      {current && copy && (
        <ModalDialog
          label={copy.title}
          describedBy={descriptionId}
          onClose={() => settle("cancel")}
          backdropClassName="confirm-action-backdrop"
        >
          <PopIn
            className="modal confirm-action-modal"
            data-destructive={copy.destructive}
            data-has-alternative={Boolean(current.options.alternativeLabel)}
          >
            <div className="confirm-action-icon" aria-hidden="true">
              {copy.destructive ? <Trash2 size={19} /> : <CircleAlert size={19} />}
            </div>
            <h2>{copy.title}</h2>
            <p id={descriptionId}>{copy.description}</p>
            <div className="modal-actions">
              <Button autoFocus variant="ghost" onClick={() => settle("cancel")}>
                {current.options.cancelLabel ?? t`Cancel`}
              </Button>
              {current.options.alternativeLabel && (
                current.options.alternativeDestructive ? (
                  <DestructiveButton
                    className={buttonClassName({ variant: "danger" })}
                    iconSize={13}
                    onClick={() => settle("alternative")}
                  >
                    {current.options.alternativeLabel}
                  </DestructiveButton>
                ) : (
                  <Button variant="secondary" onClick={() => settle("alternative")}>
                    {current.options.alternativeLabel}
                  </Button>
                )
              )}
              {copy.destructive ? (
                <DestructiveButton
                  className={buttonClassName({ variant: "danger" })}
                  iconSize={13}
                  onClick={() => settle("confirm")}
                >
                  {copy.confirmLabel}
                </DestructiveButton>
              ) : (
                <MotionButton
                  className={buttonClassName({ variant: "primary" })}
                  onClick={() => settle("confirm")}
                >
                  {copy.confirmLabel}
                </MotionButton>
              )}
            </div>
          </PopIn>
        </ModalDialog>
      )}
    </>
  );
}
