/**
 * The review bar across the top of a source editor in review mode, Word's
 * Review ribbon cut down to what reviewing one's own edits needs: how many
 * changes there are, the previous and next one, accept or reject the one at
 * the caret, accept or reject them all, the PDF with the changes marked, and
 * turning review mode off.
 *
 * CodeMirror owns the bar's element (a top panel, review-mode-extension.ts);
 * this draws into each one on screen, so the bar is the design system's
 * buttons rather than hand-built DOM.
 */
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronUp, FileDiff, ListChecks, ListX, PenOff, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Tip } from "../components/icon-tip";
import { hueColor } from "../components/ui/collab-colors";
import { IconButton } from "../components/ui/icon-button";
import { formatCount } from "../i18n";
import {
  acceptAll, decideAtCaret, moveToChange, rejectAll, reviewPanels, type ReviewPanel,
} from "./review-mode-extension";
import { REVIEW_HUE } from "./review-mode-diff";
import { reviewMode } from "./review-mode-store";
import "./review-mode.css";

/** Every review bar on screen, each drawn into its editor's panel; and review mode read for the project. */
export function ReviewModeBars({ projectRoot }: { projectRoot: string }) {
  const panels = useSyncExternalStore(reviewPanels.subscribe, reviewPanels.get);
  useEffect(() => void reviewMode.load(projectRoot || null), [projectRoot]);
  return <>{panels.map((panel) => createPortal(<ReviewBar panel={panel} />, panel.dom, panel.path))}</>;
}

function ReviewBar({ panel }: { panel: ReviewPanel }) {
  const { t, i18n } = useLingui();
  const { count, index } = useSyncExternalStore(panel.subscribe, panel.read);
  const { marked, notice } = useSyncExternalStore(reviewMode.subscribe, reviewMode.get);
  const { view } = panel;
  const none = count === 0;
  const atChange = index >= 0;
  return (
    <div className="review-bar" role="toolbar" aria-label={t`Review`}>
      <span className="review-bar-title">
        <i aria-hidden="true" style={{ background: hueColor(REVIEW_HUE) }} />
        <span className="review-bar-label">{t`Tracking changes`}</span>
      </span>
      <span className="review-bar-count" aria-live="polite">
        {none
          ? t`No changes`
          : atChange
            ? t({ message: `${formatCount(index + 1, i18n.locale)} of ${formatCount(count, i18n.locale)}`, context: "the tracked change at the caret, of all of them" })
            : t({ message: `${formatCount(count, i18n.locale)} changes`, context: "tracked changes waiting for review" })}
      </span>
      <span className="review-bar-group">
        <IconButton size="compact" label={t`Previous change`} disabled={none} onClick={() => moveToChange(view, -1)}>
          <ChevronUp aria-hidden="true" />
        </IconButton>
        <IconButton size="compact" label={t`Next change`} disabled={none} onClick={() => moveToChange(view, 1)}>
          <ChevronDown aria-hidden="true" />
        </IconButton>
      </span>
      <span className="review-bar-group">
        <IconButton size="compact" label={t`Accept`} disabled={!atChange} onClick={() => decideAtCaret(view, true)}>
          <Check aria-hidden="true" />
        </IconButton>
        <IconButton size="compact" label={t`Reject`} disabled={!atChange} onClick={() => decideAtCaret(view, false)}>
          <X aria-hidden="true" />
        </IconButton>
      </span>
      <span className="review-bar-group review-bar-all">
        {/* Named by a tooltip too: a narrow editor shows these as icons alone. */}
        <Tip label={t`Accept all`}>
          <button type="button" className="review-bar-text" disabled={none} onClick={() => acceptAll(view)}>
            <ListChecks aria-hidden="true" />
            <span className="review-bar-label">{t`Accept all`}</span>
          </button>
        </Tip>
        <Tip label={t`Reject all`}>
          <button type="button" className="review-bar-text" disabled={none} onClick={() => rejectAll(view)}>
            <ListX aria-hidden="true" />
            <span className="review-bar-label">{t`Reject all`}</span>
          </button>
        </Tip>
      </span>
      <span className="review-bar-end">
        <IconButton
          size="compact"
          label={marked ? t`Show the PDF without changes` : t`Show changes in the PDF`}
          className={marked ? "active" : undefined}
          aria-pressed={marked}
          onClick={() => reviewMode.setMarked(!marked)}
        >
          <FileDiff aria-hidden="true" />
        </IconButton>
        <Tip label={t`Stop tracking`}>
          <button
            type="button"
            className="review-bar-text"
            onClick={() => void (count > 0 ? reviewMode.confirmStop() : reviewMode.stop())}
          >
            <PenOff aria-hidden="true" />
            <span className="review-bar-label">{t`Stop tracking`}</span>
          </button>
        </Tip>
      </span>
      {notice && (
        <span className="review-bar-notice" role="status">
          <span>{notice}</span>
          <IconButton size="compact" label={t`Dismiss`} onClick={() => reviewMode.setNotice(null)}>
            <X aria-hidden="true" />
          </IconButton>
        </span>
      )}
    </div>
  );
}
