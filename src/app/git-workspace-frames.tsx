/**
 * The Git drawer's body: the Synara frames behind its Changes, Pull requests
 * and Agent turn tabs, and the shell that holds their place until one has
 * rendered.
 *
 * Each view is its own Synara client, booted in an iframe that shares the
 * host's main thread in WebKit. Pointing one iframe at whichever tab is
 * selected rebooted the whole client on every switch: the click took up to a
 * second to even select its tab and up to four for the view to change, with
 * the old view on screen meanwhile, so the tabs read as doing nothing. So a
 * view's frame stays mounted once visited, under the selected one, and
 * switching back to it is a visibility change.
 *
 * Until the selected frame has rendered, a Git-shaped skeleton with a polite
 * status covers it, from the click on: the runtime starting, the frame's
 * document loading, and the client booting would otherwise be a blank panel
 * for up to a second or more. The frame says it has rendered by posting
 * `synara:embed-ready` (Synara's `docs/lattice-git-embed.md`), after which its
 * own skeleton rows take over. A build that never posts it is released by the
 * frame's load event plus a grace period, and a frame that does neither in
 * time gets an error state with Retry instead of an endless skeleton.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { CircleAlert, CloudUpload, GitBranch, GitPullRequest, Search } from "lucide-react";
import { InfinityLoader, ReloadButton } from "../components/ui/activity-icons";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import type { AgentGitWorkspaceView, SynaraRuntimeInfo } from "../agent/synara-runtime";
import { synaraSourceControlUrl, synaraTurnReviewUrl, type AgentTurnReview, type SynaraFrameContext } from "./app-synara-embed";
import { LoadingAnnouncement } from "./tool-loading-shell";

export type GitWorkspaceFrameKey = AgentGitWorkspaceView | "agent-turn";

/** How long after its load event a frame that never says it is ready is taken as rendered anyway. */
export const GIT_FRAME_READY_GRACE_MS = 2500;
/** How long a frame may stay unrendered before the shell offers Retry. */
export const GIT_FRAME_STALL_MS = 20_000;

export function GitWorkspaceFrames({ frame, view, turnReview, runtime, onRetryRuntime, frameRef }: {
  /** Where the frames point; null until the Synara runtime is ready. */
  frame: SynaraFrameContext | null;
  view: AgentGitWorkspaceView;
  /** Non-null while the drawer is pinned to an agent turn, which then is the selected view. */
  turnReview: AgentTurnReview | null;
  runtime: SynaraRuntimeInfo;
  onRetryRuntime: () => void;
  /** Set to the selected frame: the one the host's bridges and the close message listen to. */
  frameRef: RefObject<HTMLIFrameElement | null>;
}) {
  const { t } = useLingui();
  const active: GitWorkspaceFrameKey = turnReview ? "agent-turn" : view;
  const srcOf = (key: GitWorkspaceFrameKey) => {
    if (!frame) return null;
    if (key === "agent-turn") return turnReview ? synaraTurnReviewUrl(frame, turnReview) : null;
    return synaraSourceControlUrl(frame, key);
  };

  // The views opened so far, in order. The pinned turn leaves with its tab.
  const [visited, setVisited] = useState<GitWorkspaceFrameKey[]>([active]);
  const kept = visited.filter((key) => key !== "agent-turn" || turnReview);
  const mounted = kept.includes(active) ? kept : [...kept, active];
  if (mounted.length !== visited.length || mounted.some((key, index) => key !== visited[index])) setVisited(mounted);

  // Keyed by the URL that rendered, so a frame sent somewhere new (another
  // theme, locale or turn) is covered again until that has rendered too.
  const [readySrc, setReadySrc] = useState<Partial<Record<GitWorkspaceFrameKey, string>>>({});
  const [stalledSrc, setStalledSrc] = useState<Partial<Record<GitWorkspaceFrameKey, string>>>({});
  /** Retries per view: part of its frame's key, so a retry remounts only the frame that stalled. */
  const [attempts, setAttempts] = useState<Partial<Record<GitWorkspaceFrameKey, number>>>({});
  const attempt = attempts[active] ?? 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const origin = frame?.origin ?? null;
  useEffect(() => {
    if (!origin) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || (event.data as { type?: unknown } | null)?.type !== "synara:embed-ready") return;
      for (const element of containerRef.current?.querySelectorAll<HTMLIFrameElement>("iframe[data-git-view]") ?? []) {
        if (element.contentWindow !== event.source) continue;
        const src = element.getAttribute("src");
        if (src) setReadySrc(markReady(element.dataset.gitView as GitWorkspaceFrameKey, src));
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [origin]);

  const graceTimers = useRef(new Set<number>());
  useEffect(() => {
    const timers = graceTimers.current;
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);
  const onFrameLoad = (key: GitWorkspaceFrameKey, src: string) => {
    const timer = window.setTimeout(() => {
      graceTimers.current.delete(timer);
      setReadySrc(markReady(key, src));
    }, GIT_FRAME_READY_GRACE_MS);
    graceTimers.current.add(timer);
  };

  const activeSrc = srcOf(active);
  const activeReady = activeSrc !== null && readySrc[active] === activeSrc;
  const stalled = activeSrc !== null && !activeReady && stalledSrc[active] === activeSrc;
  useEffect(() => {
    if (activeSrc === null || activeReady) return;
    const timer = window.setTimeout(() => {
      setStalledSrc((current) => ({ ...current, [active]: activeSrc }));
    }, GIT_FRAME_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [active, activeReady, activeSrc, attempt]);

  if (runtime.state === "stopped") return <SynaraLoadingSurface runtime={runtime} onRetry={onRetryRuntime} />;

  const titles: Record<GitWorkspaceFrameKey, string> = {
    changes: t`Changes`,
    "pull-requests": t`Pull requests`,
    "agent-turn": t`Agent turn review`,
  };
  const loadingMessages: Record<GitWorkspaceFrameKey, string> = {
    changes: t`Loading changes…`,
    "pull-requests": t`Loading pull requests…`,
    "agent-turn": t`Loading the agent turn…`,
  };
  const retry = () => {
    setStalledSrc((current) => ({ ...current, [active]: undefined }));
    setAttempts((current) => ({ ...current, [active]: (current[active] ?? 0) + 1 }));
  };

  return (
    <div className="git-workspace-body" ref={containerRef}>
      {mounted.map((key) => {
        const src = srcOf(key);
        if (src === null) return null;
        const selected = key === active;
        return (
          <iframe
            key={`${key}:${attempts[key] ?? 0}`}
            ref={selected ? frameRef : undefined}
            data-git-view={key}
            data-active={selected || undefined}
            aria-hidden={selected ? undefined : true}
            tabIndex={selected ? undefined : -1}
            className="synara-source-control-frame"
            src={src}
            title={titles[key]}
            onLoad={() => onFrameLoad(key, src)}
            allow="clipboard-read; clipboard-write"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
          />
        );
      })}
      {/* Kept once its frame has rendered, transparent and out of the
          accessibility tree, so it can fade out without a mount to wait on. */}
      <div className="git-workspace-shell" data-ready={activeReady || undefined} aria-hidden={activeReady || undefined}>
        {stalled ? (
          <div className="git-workspace-stalled" role="alert">
            <CircleAlert size={17} aria-hidden="true" />
            <strong>{t`Git workspace didn’t load`}</strong>
            <span>{t`The local Git service hasn’t answered. Try loading it again.`}</span>
            <ReloadButton size="compact" variant="primary" onClick={retry}>{t`Retry`}</ReloadButton>
          </div>
        ) : (
          <GitWorkspaceSkeleton view={active} message={activeReady ? null : loadingMessages[active]} />
        )}
      </div>
    </div>
  );
}

/** The update recording that the frame of `key` has rendered `src`. */
function markReady(key: GitWorkspaceFrameKey, src: string) {
  return (current: Partial<Record<GitWorkspaceFrameKey, string>>) => (current[key] === src ? current : { ...current, [key]: src });
}

/** Row widths (%) for the skeleton's file names, varied so they read as paths. */
const STAGED_ROWS = [46];
const CHANGED_ROWS = [34, 52, 41, 60, 28, 47];
const PULL_REQUEST_ROWS = [64, 48, 72, 56];

/**
 * A placeholder shaped like the view it stands for, so the hand-off to the
 * view's own skeleton rows does not jump: the branch and commit controls and
 * two sections of file rows for Changes, the filters, search and list for
 * Pull requests. Its icons are the controls' own, drawn at once rather than
 * after the view's data arrives. A sheen crosses it as a transform, so it
 * costs no repaint.
 */
function GitWorkspaceSkeleton({ view, message }: {
  view: GitWorkspaceFrameKey;
  /** What the status says; null once the view has rendered and the shell is fading. */
  message: string | null;
}) {
  return (
    <>
      <div className="git-workspace-skeleton" aria-hidden="true">
        {view === "pull-requests" ? (
          <>
            <div className="git-workspace-skeleton-heading"><GitPullRequest size={14} /><span style={{ width: "34%" }} /></div>
            <div className="git-workspace-skeleton-filters"><span /><span /></div>
            <div className="git-workspace-skeleton-control"><Search size={14} /><span style={{ width: "40%" }} /></div>
            <ul className="git-workspace-skeleton-rows git-workspace-skeleton-cards">
              {PULL_REQUEST_ROWS.map((width, index) => (
                <li key={index}><span className="git-workspace-skeleton-tile" /><span className="git-workspace-skeleton-lines"><span style={{ width: `${width}%` }} /><span style={{ width: `${width * 0.55}%` }} /></span></li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="git-workspace-skeleton-control"><GitBranch size={14} /><span style={{ width: "22%" }} /></div>
            {view === "changes" && <div className="git-workspace-skeleton-control"><CloudUpload size={14} /><span style={{ width: "30%" }} /></div>}
            {[STAGED_ROWS, CHANGED_ROWS].map((rows, section) => (
              <ul key={section} className="git-workspace-skeleton-rows">
                <li className="git-workspace-skeleton-section"><span style={{ width: section ? "18%" : "14%" }} /></li>
                {rows.map((width, index) => (
                  <li key={index}><span className="git-workspace-skeleton-icon" /><span style={{ width: `${width}%` }} /><span className="git-workspace-skeleton-stat" /></li>
                ))}
              </ul>
            ))}
          </>
        )}
      </div>
      {message !== null && (
        <>
          <div className="git-workspace-loading" aria-busy="true">
            <InfinityLoader size={14} />
            <span aria-hidden="true">{message}</span>
          </div>
          <LoadingAnnouncement message={message} />
        </>
      )}
    </>
  );
}
