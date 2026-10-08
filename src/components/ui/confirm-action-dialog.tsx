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
import { MotionButton } from "./motion";

type PendingConfirmation = {
  id: number;
  options: ConfirmActionOptions;
  resolve: (answer: ConfirmActionChoice) => void;
};

let nextConfirmationId = 1;

function firstQuestion(message: string): { title: string | null; description: string } {
  const question = message.indexOf("?");
  if (question < 0 || question > 96) return { title: null, description: message };
  return { title: message.slice(0, question + 1).trim(), description: message.slice(question + 1).trim() };
}

type CopyDefaults = Record<
  | "deleteTitle" | "continueTitle" | "deleteLabel" | "removeLabel" | "restoreLabel"
  | "continueLabel" | "destructiveDescription" | "continueDescription",
  string
>;

function confirmationCopy(options: ConfirmActionOptions, defaults: CopyDefaults) {
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
  const description = (
    split.description
    || (options.message !== title ? options.message : "")
    || (destructive ? defaults.destructiveDescription : defaults.continueDescription)
  ).replace(/[.。]$/, "");
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

  const copy = current && confirmationCopy(current.options, {
    deleteTitle: t`Delete this item?`,
    continueTitle: t`Continue?`,
    deleteLabel: t`Delete`,
    removeLabel: t`Remove`,
    restoreLabel: t`Restore`,
    continueLabel: t`Continue`,
    destructiveDescription: t`This action cannot be undone.`,
    continueDescription: t`Please confirm that you want to continue.`,
  });
  // The destructive confirmation leads its row, tinted; a destructive
  // alternative beside a safe one ("Don't save" beside Save) stays quiet.
  const dangerButton = (answer: ConfirmActionChoice, label: string) => (
    <DestructiveButton
      className={buttonClassName({ variant: answer === "confirm" ? "danger" : "ghost", className: "confirm-action-danger" })}
      iconSize={13}
      onClick={() => settle(answer)}
    >
      {label}
    </DestructiveButton>
  );

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
          <div
            className="modal confirm-action-modal"
            data-destructive={copy.destructive}
            data-has-alternative={Boolean(current.options.alternativeLabel)}
          >
            <div className="modal-icon" data-tone={copy.destructive ? "danger" : undefined} aria-hidden="true">
              {copy.destructive ? <Trash2 size={18} /> : <CircleAlert size={18} />}
            </div>
            <h2>{copy.title}</h2>
            <p id={descriptionId}>{copy.description}</p>
            <div className="modal-actions">
              <Button autoFocus variant="ghost" onClick={() => settle("cancel")}>
                {current.options.cancelLabel ?? t`Cancel`}
              </Button>
              {current.options.alternativeLabel && (current.options.alternativeDestructive
                ? dangerButton("alternative", current.options.alternativeLabel)
                : <Button variant="secondary" onClick={() => settle("alternative")}>{current.options.alternativeLabel}</Button>)}
              {copy.destructive ? dangerButton("confirm", copy.confirmLabel) : (
                <MotionButton className={buttonClassName({ variant: "primary" })} onClick={() => settle("confirm")}>
                  {copy.confirmLabel}
                </MotionButton>
              )}
            </div>
          </div>
        </ModalDialog>
      )}
    </>
  );
}
