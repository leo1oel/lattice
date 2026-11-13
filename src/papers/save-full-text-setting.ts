/**
 * Whether adding a paper also saves its full text (the converted Markdown and
 * its overview under .research/papers) or adds only its citation. Off until
 * the writer turns it on: a reference list is usually what is being built,
 * and a citation alone needs only the metadata lookup. One choice for every
 * window, set from the Add papers sheet (where the last choice sticks) or in
 * Settings. Opening a paper to read it still saves its text, whatever this says.
 */
import { sharedSetting } from "../settings/shared-setting";

const SAVE_FULL_TEXT_KEY = "lattice.papers.save-full-text.v1";

function loadSaveFullText(): boolean {
  try {
    return localStorage.getItem(SAVE_FULL_TEXT_KEY) === "true";
  } catch {
    return false;
  }
}

export const saveFullTextSetting = sharedSetting(SAVE_FULL_TEXT_KEY, loadSaveFullText);
