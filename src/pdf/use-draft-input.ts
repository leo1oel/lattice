import { useReducer, useRef, type ChangeEvent, type FocusEvent, type KeyboardEvent } from "react";
import { useCompositionGuard } from "../hooks/use-composition-guard";

/**
 * A toolbar value that reads as text until focused, then edits a draft that is
 * committed on blur (Enter) or, with `cancelOnEscape`, dropped on Escape.
 * Either key hands focus to `readingTarget` (the pages, when there are any),
 * so the reader goes on with PageDown or Space; the Enter or Escape that ends
 * an IME composition only ends the composition.
 */
export function useDraftInput(
  value: string,
  commit: (draft: string) => void,
  { accept, cancelOnEscape = false, readingTarget }: {
    accept?: RegExp;
    cancelOnEscape?: boolean;
    readingTarget: () => HTMLElement | null;
  },
) {
  const [draft, setDraft] = useReducer((_: string | null, next: string | null) => next, null);
  const cancelledRef = useRef(false);
  const { compositionProps, isComposing } = useCompositionGuard();
  // Moving focus is what blurs the field, and so commits or drops the draft.
  const leave = (input: HTMLInputElement) => {
    const target = readingTarget();
    if (target) target.focus({ preventScroll: true });
    else input.blur();
  };
  return {
    editing: draft !== null,
    draft: draft ?? "",
    inputProps: {
      ...compositionProps,
      value: draft ?? value,
      onFocus: (event: FocusEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        cancelledRef.current = false;
        setDraft(value);
        requestAnimationFrame(() => input.select());
      },
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        if (!accept || accept.test(event.target.value)) setDraft(event.target.value);
      },
      onBlur: () => {
        if (!cancelledRef.current) commit(draft ?? "");
        cancelledRef.current = false;
        setDraft(null);
      },
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (isComposing(event)) return;
        if (event.key === "Enter") leave(event.currentTarget);
        if (cancelOnEscape && event.key === "Escape") {
          cancelledRef.current = true;
          leave(event.currentTarget);
        }
      },
    },
  };
}
