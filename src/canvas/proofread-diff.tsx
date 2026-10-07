import { FileDiff } from "@pierre/diffs/react";
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";
import { PIERRE_UNSAFE_CSS, pierreFileDiff, usePierreResources } from "../history/pierre-diff";
import { PROOFREAD_MAX_LENGTH } from "../agent/agent-proofread";

/** The app's Pierre stylesheet, letting the card's frosted surface show through. */
const PROOFREAD_DIFF_CSS = `${PIERRE_UNSAFE_CSS}
:host {
  --diffs-bg: transparent !important;
  --diffs-light-bg: transparent !important;
  --diffs-dark-bg: transparent !important;
  --diffs-bg-context-override: transparent !important;
  background: transparent !important;
}
[data-diff],
[data-file],
[data-error-wrapper] {
  --diffs-bg: transparent !important;
  background: transparent !important;
}
`;

const lineEnded = (text: string) => text.endsWith("\n") ? text : `${text}\n`;

/**
 * The original selection against the agent's proofread, unified with
 * word-level highlights. Lazily loaded: Pierre and its highlighter stay out
 * of the editor's startup chunk until the first proofread.
 */
export function ProofreadDiff(props: { path: string; before: string; after: string }) {
  const { t } = useLingui();
  const { path, before, after } = props;
  const resources = usePierreResources(path);
  // An excerpt rarely ends in a line break; ending both sides in one keeps
  // Pierre's "No newline at end of file" rows out of a mid-file selection.
  const fileDiff = useMemo(
    () => pierreFileDiff({ path, before: lineEnded(before), after: lineEnded(after) }, resources.language),
    [after, before, path, resources.language],
  );
  if (resources.error) {
    const errorMessage = resources.error.message;
    return <InlineMessage level="error">{t`Could not render this diff: ${errorMessage}`}</InlineMessage>;
  }
  if (!resources.ready) {
    return <p className="proofread-card-note" role="status"><InfinityLoader size={12} /> {t`Rendering diff…`}</p>;
  }
  return (
    <FileDiff
      key={`${resources.preloadKey}:${before.length}:${after.length}`}
      fileDiff={fileDiff}
      options={{
        diffStyle: "unified",
        lineDiffType: "word",
        // A paragraph is often one source line: highlight its words however long it is.
        maxLineDiffLength: PROOFREAD_MAX_LENGTH,
        tokenizeMaxLineLength: PROOFREAD_MAX_LENGTH,
        // The excerpt is short; show all of it, without collapsed-context rows.
        expandUnchanged: true,
        overflow: "wrap",
        disableFileHeader: true,
        disableLineNumbers: true,
        theme: resources.themeName,
        themeType: resources.theme,
        unsafeCSS: PROOFREAD_DIFF_CSS,
      }}
      disableWorkerPool
    />
  );
}
