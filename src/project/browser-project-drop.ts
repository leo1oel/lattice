import { dropDirectoryAt } from "../app-utils";

/** Ordinary browsers expose File bytes, not the OS paths used by the desktop. */
export function listenForBrowserProjectDrops(
  onDrop: (files: File[], directory: string) => void,
  onTarget: (directory: string | null) => void,
): () => void {
  const over = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    const scale = window.devicePixelRatio || 1;
    const target = dropDirectoryAt({ x: event.clientX * scale, y: event.clientY * scale });
    onTarget(target);
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };
  const drop = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    onTarget(null);
    const scale = window.devicePixelRatio || 1;
    const target = dropDirectoryAt({ x: event.clientX * scale, y: event.clientY * scale });
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    // Capture synchronously: the browser protects the data store after dispatch.
    onDrop(Array.from(event.dataTransfer.files), target);
  };
  const leave = (event: DragEvent) => {
    if (!event.relatedTarget) onTarget(null);
  };
  window.addEventListener("dragover", over, true);
  window.addEventListener("drop", drop, true);
  window.addEventListener("dragleave", leave, true);
  return () => {
    window.removeEventListener("dragover", over, true);
    window.removeEventListener("drop", drop, true);
    window.removeEventListener("dragleave", leave, true);
  };
}
