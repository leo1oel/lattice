import { hostPlatform } from "../../platform/host-platform";

const isSecondaryClick = (event: PointerEvent) => (
  event.button === 0 && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
);

const isAddRangeClick = (event: PointerEvent) => (
  event.button === 0 && event.metaKey && !event.ctrlKey && !event.altKey
);

/**
 * A Mac's Control-click is its secondary click, but WebKit reports it as the
 * primary button with Control held. Univer reads that as Ctrl+click, which
 * adds a range on Windows, so the press drew a selection over the sheet and
 * opened no menu. The press and its release reach Univer as the right button
 * they stand for: a cell outside the selection is selected, one inside keeps
 * it, and the context menu opens.
 *
 * Univer adds a range only for Ctrl, never for Command, so a Mac's
 * Command-click reaches it with Control in Command's place.
 */
export function secondaryClickAsRightButton(host: HTMLElement): () => void {
  if (hostPlatform() !== "mac") return () => {};
  const pressed = new Set<number>();
  const translated = new WeakSet<Event>();
  const redispatch = (event: PointerEvent) => {
    if (translated.has(event)) return;
    const press = event.type === "pointerdown";
    const addRange = press && isAddRangeClick(event);
    if (!addRange && (press ? !isSecondaryClick(event) : !pressed.delete(event.pointerId))) return;
    if (press && !addRange) pressed.add(event.pointerId);
    event.stopImmediatePropagation();
    event.preventDefault();
    const stand = new PointerEvent(event.type, {
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      composed: event.composed,
      view: event.view,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      width: event.width,
      height: event.height,
      pressure: event.pressure,
      ...(addRange
        ? { button: 0, buttons: event.buttons, ctrlKey: true, shiftKey: event.shiftKey }
        : { button: 2, buttons: press ? 2 : 0 }),
    });
    translated.add(stand);
    event.target?.dispatchEvent(stand);
  };
  host.addEventListener("pointerdown", redispatch, true);
  host.addEventListener("pointerup", redispatch, true);
  return () => {
    host.removeEventListener("pointerdown", redispatch, true);
    host.removeEventListener("pointerup", redispatch, true);
  };
}
