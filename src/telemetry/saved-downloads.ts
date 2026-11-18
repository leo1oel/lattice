/**
 * Says where a download this window started was saved. A board's Export
 * image (Excalidraw) and the diagnostic log's Download are WebKit downloads
 * the host puts in the Downloads folder (src-tauri/src/saved_downloads.rs);
 * without this they land there without a word.
 */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { subscribeTauriEvent } from "../app/effect-helpers";
import { listenInThisWindow } from "../app/window-events";
import { notifySuccess } from "./app-notify";

/** `DOWNLOAD_SAVED_EVENT` in src-tauri/src/saved_downloads.rs; the payload is the saved file's path. */
export const DOWNLOAD_SAVED_EVENT = "download-saved";

export function installSavedDownloadNotice(): () => void {
  return subscribeTauriEvent<string>(
    (handler) => listenInThisWindow(DOWNLOAD_SAVED_EVENT, handler),
    (path) => notifySuccess(i18n._(msg`Download`), i18n._(msg`Saved to ${path}`)),
  );
}
