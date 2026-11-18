/**
 * Whether a source diff in Compare versions wraps its long lines instead of
 * scrolling sideways. LaTeX paragraphs are often one long line, so a writer who
 * turns wrapping on wants it the next time too, in every window. Off by
 * default: wrapped lines no longer line up with the columns of the file.
 */
import { sharedSetting } from "../settings/shared-setting";

const DIFF_WRAP_KEY = "lattice.history.diff-wrap.v1";

function loadDiffWrap(): boolean {
  try {
    return localStorage.getItem(DIFF_WRAP_KEY) === "true";
  } catch {
    return false;
  }
}

export const diffWrapSetting = sharedSetting(DIFF_WRAP_KEY, loadDiffWrap);
