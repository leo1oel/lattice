/**
 * The palette's Format document: latexindent through texlab, on the focused
 * .tex file. Loaded on its first use, with the texlab language behind it, so
 * the eager command table carries only the call.
 */
import { msg } from "@lingui/core/macro";
import { formatLatexDocument } from "../build/texlab-language";
import { i18n } from "../i18n";
import { logAction } from "../telemetry/app-notify";
import { showError, showWarning } from "./notify";

/**
 * What Format document formats: a file's text as it was asked, and a replace
 * that applies the result only if that file still holds that text.
 */
export type FormatTarget = { path: string; text: string; replace: (formatted: string) => boolean };

/** Format the target's text and hand a changed result to its replace. */
export async function formatDocument({ path, text, replace }: FormatTarget) {
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
    // latexindent takes seconds on a long file; meanwhile the writer may have
    // typed, switched files or projects. The result is only right for the
    // text it was computed from, so anything else drops it.
    if (!replace(formatted)) {
      trace.finish("cancelled");
      showWarning(i18n._(msg`${path} changed while it was being formatted, so the result was not applied. Run Format document again.`), source);
      return;
    }
    trace.ok(i18n._(msg`Formatted with latexindent.`));
  } catch (reason) {
    trace.fail(reason);
  }
}
