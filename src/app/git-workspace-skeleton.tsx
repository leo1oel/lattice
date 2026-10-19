/**
 * The Git drawer's placeholder while a view's frame boots: the view's own
 * layout, measured from the rendered Synara view (a local-only repository,
 * the state a new Lattice project is in), so the hand-off moves nothing.
 * It is the drawer's one loading indicator; its words are for assistive
 * technology only.
 */
import { GitBranch, Search, Sparkles } from "lucide-react";
import { LoadingAnnouncement, useLoadingReveal } from "../components/ui/loading-status";
import type { GitWorkspaceFrameKey } from "./git-workspace-frames";
import "./git-workspace-skeleton.css";

/** Name widths (%) for the skeleton's file rows, varied so they read as paths. */
const STAGED_ROWS = [22];
const CHANGED_ROWS = [26, 34, 20, 40, 30];
const PULL_REQUEST_ROWS = [64, 48, 72, 56];

export function GitWorkspaceSkeleton({ view, message }: {
  view: GitWorkspaceFrameKey;
  /** What the status says; null once the view has rendered and the shell is fading. */
  message: string | null;
}) {
  const reveal = useLoadingReveal(`git:${view}`);
  return (
    <>
      <div className="git-skeleton loading-sheen loading-reveal" style={reveal} data-view={view} aria-hidden="true">
        {view === "pull-requests" ? <PullRequestsShape /> : <ChangesShape withComposer={view === "changes"} />}
      </div>
      {message !== null && <LoadingAnnouncement message={message} />}
    </>
  );
}

/** The branch line, the publish card and the commit composer, then the staged and unstaged files. */
function ChangesShape({ withComposer }: { withComposer: boolean }) {
  return (
    <>
      <div className="git-skeleton-branchline">
        <span className="git-skeleton-chip"><GitBranch size={14} /><span /></span>
        <span className="git-skeleton-text" style={{ width: 74 }} />
        <span className="git-skeleton-square" data-end />
        <span className="git-skeleton-square" />
      </div>
      {withComposer && (
        <>
          <div className="git-skeleton-card">
            <div className="git-skeleton-card-head">
              <span className="git-skeleton-tile" />
              <span className="git-skeleton-lines"><span style={{ width: "34%" }} /><span style={{ width: "62%" }} /></span>
            </div>
            <div className="git-skeleton-card-actions"><span /><span /></div>
          </div>
          <div className="git-skeleton-composer">
            <div className="git-skeleton-composer-line"><span style={{ width: "40%" }} /><Sparkles size={14} /></div>
            <span style={{ width: "22%" }} />
            <span className="git-skeleton-button" />
          </div>
        </>
      )}
      {[STAGED_ROWS, CHANGED_ROWS].map((rows, section) => (
        <ul key={section} className="git-skeleton-section">
          <li className="git-skeleton-section-head"><span style={{ width: section ? 72 : 52 }} /><span data-end style={{ width: section ? 61 : 75 }} /></li>
          {rows.map((width, index) => (
            <li key={index} className="git-skeleton-row">
              <span className="git-skeleton-box" />
              <span className="git-skeleton-box" />
              <span style={{ width: `${width}%` }} />
              <span className="git-skeleton-stat" />
            </li>
          ))}
        </ul>
      ))}
    </>
  );
}

function PullRequestsShape() {
  return (
    <>
      <div className="git-skeleton-search"><Search size={14} /><span style={{ width: "48%" }} /></div>
      <ul className="git-skeleton-section">
        <li className="git-skeleton-section-head"><span style={{ width: "26%" }} /></li>
        {PULL_REQUEST_ROWS.map((width, index) => (
          <li key={index} className="git-skeleton-card-row">
            <span className="git-skeleton-tile" />
            <span className="git-skeleton-lines"><span style={{ width: `${width}%` }} /><span style={{ width: `${width * 0.55}%` }} /></span>
          </li>
        ))}
      </ul>
    </>
  );
}
