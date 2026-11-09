import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { showError } from "./notify";

/**
 * Delete LaTeX auxiliary files while `cleaning` is held; false when it failed.
 * No confirmation: every file it removes is one the next build writes again.
 */
export async function cleanAuxiliaryFiles(setCleaning: (cleaning: boolean) => void): Promise<boolean> {
  setCleaning(true);
  try {
    await invoke("clean_project");
    return true;
  } catch (reason) {
    showError(toMessage(reason));
    return false;
  } finally {
    setCleaning(false);
  }
}
