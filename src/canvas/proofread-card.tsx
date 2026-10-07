import { Suspense } from "react";
import { useLingui } from "@lingui/react/macro";
import { SpellCheck } from "lucide-react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { ProofreadDiff } from "./canvas-lazy-editors";

export type ProofreadCardState =
  | { status: "loading" }
  | { status: "ready"; proofread: string }
  | { status: "error"; message: string; retryable: boolean };

/**
 * The inline proofread under the selected source: the agent's suggestion as a
 * word-level diff against the original, accepted as one edit or dismissed.
 */
export function ProofreadCard(props: {
  path: string;
  original: string;
  state: ProofreadCardState;
  editable: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const { t } = useLingui();
  const { state } = props;
  const unchanged = state.status === "ready" && state.proofread === props.original;
  const summary = state.status === "loading" ? t`Proofreading…`
    : state.status === "error" ? t`Could not proofread`
      : unchanged ? t`No changes suggested` : t`Suggested edits`;
  return (
    <div
      className="proofread-card"
      role="group"
      aria-label={t`Proofread suggestion`}
      aria-busy={state.status === "loading"}
      data-status={state.status}
    >
      <div className="proofread-card-header">
        {state.status === "loading" ? <InfinityLoader size={14} /> : <SpellCheck size={14} strokeWidth={1.8} aria-hidden />}
        <span className="proofread-card-title">{t`Proofread`}</span>
        <span className="proofread-card-summary" role="status">{summary}</span>
      </div>
      {state.status === "ready" && !unchanged && (
        <div className="proofread-card-diff">
          <Suspense fallback={<p className="proofread-card-note" role="status"><InfinityLoader size={12} /> {t`Rendering diff…`}</p>}>
            <ProofreadDiff path={props.path} before={props.original} after={state.proofread} />
          </Suspense>
        </div>
      )}
      {state.status === "loading" && (
        <p className="proofread-card-note">{t`The agent is checking grammar, spelling and clarity. LaTeX commands, math and citations stay as written.`}</p>
      )}
      {unchanged && <p className="proofread-card-note">{t`The selection already reads cleanly.`}</p>}
      {state.status === "error" && <InlineMessage level="error" className="proofread-card-error">{state.message}</InlineMessage>}
      <div className="proofread-card-actions">
        {state.status === "ready" && !unchanged ? (
          <>
            <Button size="compact" variant="ghost" onClick={props.onDismiss}>
              {t`Reject`} <kbd>esc</kbd>
            </Button>
            <Button size="compact" variant="primary" disabled={!props.editable} onClick={props.onAccept}>
              {t`Accept`} <kbd>⌘↵</kbd>
            </Button>
          </>
        ) : state.status === "error" ? (
          <>
            <Button size="compact" variant="ghost" onClick={props.onDismiss}>{t`Dismiss`}</Button>
            {state.retryable && <Button size="compact" onClick={props.onRetry}>{t`Try again`}</Button>}
          </>
        ) : (
          <Button size="compact" variant="ghost" onClick={props.onDismiss}>
            {state.status === "loading" ? t`Cancel` : t`Done`} <kbd>esc</kbd>
          </Button>
        )}
      </div>
    </div>
  );
}
