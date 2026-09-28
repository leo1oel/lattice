import { dropDirectoryAt } from "../app-utils";

/** Ordinary browsers expose File bytes, not the OS paths used by the desktop. */
export function listenForBrowserProjectDrops(
  onDrop: (files: File[], directory: string) => void,
  onTarget: (directory: string | null) => void,
): () => void {
  /** `dropDirectoryAt` hit-tests in device pixels, like the desktop drop bridge. */
  const targetOf = (event: DragEvent) => {
    const scale = window.devicePixelRatio || 1;
    return dropDirectoryAt({ x: event.clientX * scale, y: event.clientY * scale });
  };
  const over = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    const target = targetOf(event);
    onTarget(target);
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };
  const drop = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    onTarget(null);
    const target = targetOf(event);
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    // Capture synchronously: the browser protects the data store after dispatch.
    onDrop(Array.from(event.dataTransfer.files), target);
  };
  const leave = (event: DragEvent) => {
    if (!event.relatedTarget) onTarget(null);
  };
  const listeners = [["dragover", over], ["drop", drop], ["dragleave", leave]] as const;
  for (const [type, listener] of listeners) window.addEventListener(type, listener, true);
  return () => {
    for (const [type, listener] of listeners) window.removeEventListener(type, listener, true);
  };
}
