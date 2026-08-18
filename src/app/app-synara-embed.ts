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

export function synaraEmbedUrl(
  origin: string,
  authToken: string | null,
  projectRoot: string,
  theme: "light" | "dark",
  locale: AppLocale,
): string {
  return synaraFrameUrl({
    origin,
    workspaceRoot: projectRoot,
    theme,
    locale,
    surface: "chrome",
    hostOrigin: window.location.origin,
    authToken,
  });
}

export function synaraSourceControlUrl(
  origin: string,
  authToken: string | null,
  projectRoot: string,
  theme: "light" | "dark",
  locale: AppLocale,
  view: AgentGitWorkspaceView,
): string {
  return synaraFrameUrl({
    origin,
    path: agentGitWorkspacePath(view),
    workspaceRoot: projectRoot,
    theme,
    locale,
    surface: "drawer",
    hostOrigin: window.location.origin,
    authToken,
  });
}

/** A turn's checkpoint diff, reviewable even after the working tree moved on. */
export type AgentTurnReview = { threadId: string; turnId: string; filePath: string | null };

export function synaraTurnReviewUrl(
  origin: string,
  authToken: string | null,
  projectRoot: string,
  theme: "light" | "dark",
  locale: AppLocale,
  review: AgentTurnReview,
): string {
  const url = new URL(synaraFrameUrl({
    origin,
    path: "/review",
    workspaceRoot: projectRoot,
    theme,
    locale,
    surface: "drawer",
    hostOrigin: window.location.origin,
    authToken,
  }));
  url.searchParams.set("threadId", review.threadId);
  url.searchParams.set("turnId", review.turnId);
  if (review.filePath) url.searchParams.set("filePath", review.filePath);
  return url.toString();
}
