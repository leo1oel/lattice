import { useEffect, useRef, type CompositionEventHandler, type KeyboardEventHandler } from "react";

/**
 * Keeps Enter from acting while an IME candidate is being accepted. WebKit can
 * emit compositionend immediately before the Enter that accepted the
 * candidate, so the guard stays up for the rest of that event turn.
 */
export function useCompositionGuard() {
  const composingRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);
  const cancelClear = () => {
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = null;
  };
  useEffect(() => () => {
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);
  }, []);
  return {
    compositionProps: {
      onCompositionStart: () => {
        cancelClear();
        composingRef.current = true;
      },
      onCompositionEnd: () => {
        cancelClear();
        clearTimerRef.current = window.setTimeout(() => {
          composingRef.current = false;
          clearTimerRef.current = null;
        }, 0);
      },
    },
    isComposing: (event: React.KeyboardEvent) => (
      event.nativeEvent.isComposing
      || event.keyCode === 229
      || event.key === "Process"
      || composingRef.current
    ),
  };
}

type TextFieldKeyProps<T extends Element> = {
  onKeyDown?: KeyboardEventHandler<T>;
  onCompositionStart?: CompositionEventHandler<T>;
  onCompositionEnd?: CompositionEventHandler<T>;
};

/**
 * A text field's key handler, run only for keys the writer meant for the
 * field: while an input method composes, Enter puts down the candidate (or the
 * pinyin as letters), Escape drops the candidates and the arrows move among
 * them. The shared `Input`, `Textarea` and `SearchField` route `onKeyDown`
 * through this, so a submit-on-Enter there is safe without a guard of its own.
 */
export function useCompositionSafeKeys<T extends Element>(props: TextFieldKeyProps<T>): TextFieldKeyProps<T> {
  const { compositionProps, isComposing } = useCompositionGuard();
  const { onKeyDown, onCompositionStart, onCompositionEnd } = props;
  return {
    onCompositionStart: (event) => {
      compositionProps.onCompositionStart();
      onCompositionStart?.(event);
    },
    onCompositionEnd: (event) => {
      compositionProps.onCompositionEnd();
      onCompositionEnd?.(event);
    },
    onKeyDown: onKeyDown && ((event) => {
      if (!isComposing(event)) onKeyDown(event);
    }),
  };
}
