/**
 * Local seam — not upstream code.
 *
 * Upstream `image-upload` posts files to the Open Knowledge app server and
 * inserts the returned asset URL. Research Writer is a local-first Tauri
 * app with no upload endpoint yet, so this facade inlines the picked image
 * as a data URL. TODO(host): copy the file into the workspace assets
 * directory and insert a relative path instead.
 */
import type { Editor } from "@tiptap/core";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export async function uploadAndInsert(file: File, editor: Editor, insertPos: number): Promise<void> {
  const src = await readAsDataUrl(file);
  editor
    .chain()
    .insertContentAt(insertPos, {
      type: "image",
      attrs: { src, alt: file.name },
    })
    .focus()
    .run();
}
