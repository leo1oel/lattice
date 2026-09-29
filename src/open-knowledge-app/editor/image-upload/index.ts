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
import { toast } from "../../shims/sonner";
import { uploadFailureMessage } from "./upload-failure";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export async function uploadAndInsert(file: File, editor: Editor, insertPos: number): Promise<void> {
  let src: string;
  try {
    src = await readAsDataUrl(file);
  } catch (error) {
    // Callers fire and forget (the slash menu's file picker), so this toast is
    // the only place a failed read can reach the user.
    console.warn("[image-upload] could not read the picked file", error);
    toast.error(uploadFailureMessage("file-unreadable", file.name));
    return;
  }
  editor
    .chain()
    .insertContentAt(insertPos, {
      type: "image",
      attrs: { src, alt: file.name },
    })
    .focus()
    .run();
}
