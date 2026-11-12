/**
 * Opening a note's link into Zotero's PDF reader (`zotero://open-pdf/…`, as
 * zotero-annotations.ts writes it). The backend's `open_zotero_link` opens
 * only that link shape, so the WebView's opener stays limited to web and mail
 * links. Loaded on the first such click, so the editor carries none of it.
 */
import { t } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { hostErrorMessage } from "../app-utils";
import { notifyError } from "../telemetry/app-notify";

export async function openZoteroAnnotation(href: string): Promise<void> {
  try {
    await invoke("open_zotero_link", { url: href });
  } catch (reason) {
    notifyError(t`Papers`, t`Could not open Zotero`, { detail: hostErrorMessage(reason) });
  }
}
