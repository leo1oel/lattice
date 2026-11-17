import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { showError } from "./notify";

/**
 * Delete LaTeX auxiliary files while `cleaning` is held; false when it failed.
 * No confirmation: every file it removes is one the next build writes again.
 * `documentPath` is the open `.tex`, as `build_project` takes it: the clean is
 * of the root document a build would compile now, not of the last build's,
 * which may be another root whose `.aux` this one reads (`xr-hyper`).
 */
export async function cleanAuxiliaryFiles(setCleaning: (cleaning: boolean) => void, documentPath: string | null): Promise<boolean> {
  setCleaning(true);
  try {
    await invoke("clean_project", { documentPath });
    return true;
  } catch (reason) {
    showError(toMessage(reason));
    return false;
  } finally {
    setCleaning(false);
  }
}
