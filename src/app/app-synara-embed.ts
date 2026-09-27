/**
 * Synara embed plumbing shared by App and the render-tree modules split out of
 * it: the permission-mode guard App needs for the sidecar's postMessage
 * handshake, and the frame URLs for the agent panel and the Git/review drawer.
 */
import {
  agentGitWorkspacePath,
  synaraFrameUrl,
  type AgentGitWorkspaceView,
} from "../agent/synara-runtime";
import { type AppLocale } from "../settings/app-settings";

export type SynaraPermissionMode = "approval-required" | "auto" | "full-access";

export function isSynaraPermissionMode(value: unknown): value is SynaraPermissionMode {
  return value === "approval-required" || value === "auto" || value === "full-access";
}

const THREAD_KEY_PREFIX = "lattice.agent-thread.v1:";

export function persistSynaraThread(projectRoot: string, threadId: string): void {
  try {
    localStorage.setItem(THREAD_KEY_PREFIX + projectRoot, threadId);
  } catch {
    // The active conversation remains usable without storage.
  }
}

/** Where an embedded Synara frame points: the sidecar plus the host project, theme and locale. */
export type SynaraFrameContext = {
  origin: string;
  authToken: string | null;
  projectRoot: string;
  theme: "light" | "dark";
  locale: AppLocale;
};

function frameUrl(frame: SynaraFrameContext, surface: "chrome" | "drawer", path: string): string {
  return synaraFrameUrl({
    origin: frame.origin,
    path,
    workspaceRoot: frame.projectRoot,
    theme: frame.theme,
    locale: frame.locale,
    surface,
    hostOrigin: window.location.origin,
    authToken: frame.authToken,
  });
}

export function synaraEmbedUrl(frame: SynaraFrameContext): string {
  let path = "/";
  try {
    const threadId = localStorage.getItem(THREAD_KEY_PREFIX + frame.projectRoot);
    if (threadId && /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,511}$/.test(threadId)) {
      path = `/${encodeURIComponent(threadId)}`;
    }
  } catch {
    // Let Synara choose its normal landing page when storage is unavailable.
  }
  return frameUrl(frame, "chrome", path);
}

export function synaraSourceControlUrl(frame: SynaraFrameContext, view: AgentGitWorkspaceView): string {
  return frameUrl(frame, "drawer", agentGitWorkspacePath(view));
}

/** A turn's checkpoint diff, reviewable even after the working tree moved on. */
export type AgentTurnReview = { threadId: string; turnId: string; filePath: string | null };

export function synaraTurnReviewUrl(frame: SynaraFrameContext, review: AgentTurnReview): string {
  const url = new URL(frameUrl(frame, "drawer", "/review"));
  url.searchParams.set("threadId", review.threadId);
  url.searchParams.set("turnId", review.turnId);
  if (review.filePath) url.searchParams.set("filePath", review.filePath);
  return url.toString();
}
