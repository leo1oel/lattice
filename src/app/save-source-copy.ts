import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { i18n } from "../i18n";
import { utf8ToBase64 } from "../pdf/pdf-bytes";
import { logAction } from "../telemetry/app-notify";

/**
 * The way out when the open file cannot be written in place (a full disk, a
 * project folder that went away): ask where a copy should go and write the
 * text on screen there. The host writes UTF-8 text only, under a text file's
 * name (export.rs `save_text_copy`); a cancelled panel writes nothing.
 */
export async function saveSourceCopy(path: string, text: string): Promise<void> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const trace = logAction(i18n._(msg`Save`), i18n._(msg`Save a copy`), name, "save-source-copy");
  try {
    const destination = await saveDialog({ title: i18n._(msg`Save a copy of ${name}`), defaultPath: name });
    if (!destination) return;
    const written = await invoke<string>("save_source_copy", new TextEncoder().encode(text), {
      headers: { "x-copy-destination": utf8ToBase64(destination) },
    });
    trace.ok(i18n._(msg`Saved a copy to ${written}`));
  } catch (reason) {
    trace.fail(reason);
  } finally {
    trace.finish("cancelled");
  }
}
