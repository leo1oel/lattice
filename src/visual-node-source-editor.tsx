/* eslint-disable react-refresh/only-export-components */
import { useEffect, useId, useRef, type KeyboardEvent, type RefObject } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { Check, Pencil, X } from "lucide-react";

export const REMOTE_CHANGE_MESSAGE = "This block changed elsewhere. Cancel and reopen it before editing.";

export function restoreEditButtonFocus(
  buttonRef: RefObject<HTMLButtonElement | null>,
  editor: NodeViewProps["editor"],
) {
  requestAnimationFrame(() => {
    if (buttonRef.current) buttonRef.current.focus();
    else if (!editor.isDestroyed) editor.commands.focus();
  });
}

type SourceEditorProps = {
  label: string;
  value: string;
  multiline?: boolean;
  error?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

export function SourceEditor({
  label,
  value,
  multiline = false,
  error,
  onChange,
  onSave,
  onCancel,
}: SourceEditorProps) {
  const controlRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const errorId = useId();
  useEffect(() => {
    controlRef.current?.focus();
    controlRef.current?.select();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !multiline)) {
      event.preventDefault();
      onSave();
    }
  };
  const commonProps = {
    ref: controlRef as never,
    value,
    "aria-label": label,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errorId : undefined,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    onKeyDown,
  };
  return (
    <div className={`visual-node-source-editor${multiline ? " visual-node-source-editor-block" : ""}`}>
      <label>{label}</label>
      {multiline ? <textarea {...commonProps} rows={6} /> : <input {...commonProps} type="text" />}
      {error && <span className="visual-node-source-error" id={errorId} role="alert">{error}</span>}
      <div className="visual-node-source-actions">
        <button type="button" aria-label={`Cancel ${label}`} onClick={onCancel}>
          <X aria-hidden="true" />
          Cancel
        </button>
        <button type="button" className="primary" aria-label={`Save ${label}`} onClick={onSave}>
          <Check aria-hidden="true" />
          Save
        </button>
      </div>
      <span className="visual-node-source-hint">{multiline ? "Ctrl/⌘ + Enter to save · Esc to cancel" : "Enter to save · Esc to cancel"}</span>
    </div>
  );
}

export function EditButton({
  label,
  buttonRef,
  onClick,
}: {
  label: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button ref={buttonRef} type="button" className="visual-node-edit-button" aria-label={label} onClick={onClick}>
      <Pencil aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
