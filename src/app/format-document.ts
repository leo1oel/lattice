/**
 * The palette's Format document: latexindent through texlab, on the focused
 * .tex file. Loaded on its first use, with the texlab language behind it, so
 * the eager command table carries only the call.
 */
import { msg } from "@lingui/core/macro";
import { formatLatexDocument } from "../build/texlab-language";
import { i18n } from "../i18n";
import { logAction } from "../telemetry/app-notify";
import { showError } from "./notify";

/** Format `text`, the content of `path`, and hand a changed result to `edit`. */
export async function formatDocument(path: string, text: string, edit: (formatted: string) => void) {
  const source = i18n._(msg`Format`);
  if (!path.endsWith(".tex")) {
    showError(i18n._(msg`Open a .tex file before formatting.`), source);
    return;
  }
  const trace = logAction(source, i18n._(msg`Format document`), path);
  try {
    const formatted = await formatLatexDocument(path, text);
    if (formatted === text) {
      trace.ok(i18n._(msg`Document is already formatted.`));
      return;
    }
    edit(formatted);
    trace.ok(i18n._(msg`Formatted with latexindent.`));
  } catch (reason) {
    trace.fail(reason);
  }
}
