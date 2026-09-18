/* eslint lingui/no-unlocalized-strings: "off" -- This file defines an Agent protocol, not UI copy. */

import type { OverleafThread } from "../app-types";
import { invoke } from "@tauri-apps/api/core";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { resolveCommentAnchor } from "../editor/comments/editor-comment-data";
import type { OverleafCommentAnchor } from "../overleaf/use-overleaf-comments";

export const SYNARA_EDITOR_COMMENTS_TOOL_REQUEST = "synara:editor-comments-tool-request";
export const LATTICE_EDITOR_COMMENTS_TOOL_RESULT = "lattice:editor-comments-tool-result";

const MAX_QUOTE = 2_000;
const MAX_BODY = 3_000;
const MAX_REPLY_BODY = 1_000;
const MAX_REPLIES = 5;
const MAX_SNAPSHOT_BYTES = 64 * 1_024;

export type AgentCommentReply = { authorName: string; body: string; createdAt: string };
export type AgentComment = {
  id: string;
  origin: "local" | "overleaf";
  path: string;
  from: number;
  to: number;
  quote: string;
  body: string;
  authorName: string;
  resolved: boolean;
  replies: AgentCommentReply[];
  updatedAt: string;
  anchorStatus: "exact" | "moved" | "missing" | "unchecked";
};

export type AgentCommentsCollection = {
  workspaceRoot: string;
  capturedAt: string;
  comments: AgentComment[];
  omittedCount: number;
  overleaf: {
    status: "not-linked" | "fresh" | "cached" | "unavailable";
    fetchedAt?: string;
    error?: string;
  };
};

export type AgentEditorCommentsToolRequest = {
  type: typeof SYNARA_EDITOR_COMMENTS_TOOL_REQUEST;
  version: 1;
  id: string;
  workspaceRoot: string;
  args: { path?: string; includeResolved?: boolean; offset?: number; limit?: number };
  expiresAt: number;
};

export type AgentCommentsPage = AgentCommentsCollection & {
  totalCount: number;
  offset: number;
  nextOffset: number | null;
};

export type AgentEditorCommentsToolResult =
  | { type: typeof LATTICE_EDITOR_COMMENTS_TOOL_RESULT; version: 1; id: string; ok: true; result: AgentCommentsPage }
  | { type: typeof LATTICE_EDITOR_COMMENTS_TOOL_RESULT; version: 1; id: string; ok: false; error: { code: string; message: string } };

export type BuildAgentCommentsOptions = {
  workspaceRoot: string;
  localComments: readonly EditorComment[];
  overleafThreads: readonly OverleafThread[];
  overleafAnchors: readonly OverleafCommentAnchor[];
  docPaths: ReadonlyMap<string, string>;
  /** Full, live file contents. Callers must not pass frontmatter-stripped editor text. */
  currentSources?: ReadonlyMap<string, string>;
  overleaf: AgentCommentsCollection["overleaf"];
  path?: string;
  includeResolved?: boolean;
  offset?: number;
  limit?: number;
  capturedAt?: string;
};

function normalizedPath(path: string): string | null {
  const result = path.replace(/\\/g, "/");
  if (!result || result.startsWith("/") || /^[A-Za-z]:/.test(result)) return null;
  if (result.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return result;
}

function bounded(value: string, max: number): string {
  if (value.length <= max) return value;
  const marker = "\n[… truncated by Lattice …]";
  return `${value.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

function anchorResult(source: string | undefined, from: number, quote: string): Pick<AgentComment, "from" | "to" | "anchorStatus"> {
  if (source === undefined) return { from, to: from + quote.length, anchorStatus: "unchecked" };
  if (from >= 0 && source.slice(from, from + quote.length) === quote) {
    return { from, to: from + quote.length, anchorStatus: "exact" };
  }
  if (!quote) return { from, to: from, anchorStatus: "missing" };
  const found = source.indexOf(quote);
  if (found < 0 || source.indexOf(quote, found + 1) >= 0) {
    return { from, to: from + quote.length, anchorStatus: "missing" };
  }
  return { from: found, to: found + quote.length, anchorStatus: "moved" };
}

function capReplies(replies: readonly AgentCommentReply[]): AgentCommentReply[] {
  const kept = replies.slice(0, MAX_REPLIES).map((reply) => ({
    ...reply,
    authorName: bounded(reply.authorName, 300),
    body: bounded(reply.body, MAX_REPLY_BODY),
  }));
  if (replies.length > MAX_REPLIES) {
    kept[MAX_REPLIES - 1] = {
      authorName: "Lattice",
      body: `[… ${replies.length - MAX_REPLIES + 1} replies omitted by Lattice …]`,
      createdAt: kept[MAX_REPLIES - 1]?.createdAt ?? "",
    };
  }
  return kept;
}

export function buildAgentCommentsSnapshot(options: BuildAgentCommentsOptions): AgentCommentsPage {
  const filterPath = options.path === undefined ? undefined : normalizedPath(options.path);
  if (options.path !== undefined && filterPath === null) throw new Error("Invalid comment path filter.");
  const includeResolved = options.includeResolved ?? false;
  const comments: AgentComment[] = [];
  let unrepresentable = 0;

  for (const source of options.localComments) {
    const path = normalizedPath(source.path);
    if (!path || (filterPath && path !== filterPath) || (!includeResolved && source.resolved)) continue;
    const live = options.currentSources?.get(path);
    const resolved = live === undefined ? null : resolveCommentAnchor(live, source);
    const anchor = live === undefined
      ? { from: source.from, to: source.to, anchorStatus: "unchecked" as const }
      : resolved
        ? { ...resolved, anchorStatus: resolved.from === source.from ? "exact" as const : "moved" as const }
        : { from: source.from, to: source.to, anchorStatus: "missing" as const };
    comments.push({
      id: source.id, origin: "local", path, ...anchor,
      quote: bounded(source.quote, MAX_QUOTE), body: bounded(source.body, MAX_BODY),
      authorName: bounded(source.authorName, 300), resolved: source.resolved,
      replies: capReplies(source.replies), updatedAt: source.updatedAt,
    });
  }

  const anchors = new Map(options.overleafAnchors.map((anchor) => [anchor.threadId, anchor]));
  for (const thread of options.overleafThreads) {
    if (!includeResolved && thread.resolved) continue;
    const anchor = anchors.get(thread.id);
    const path = anchor && normalizedPath(options.docPaths.get(anchor.docId) ?? "");
    // In file scope an unmapped record may belong to that file, so it remains
    // an explicit omission rather than disappearing as a misleading empty result.
    if (!anchor || !path || thread.messages.length === 0) {
      unrepresentable += 1;
      continue;
    }
    if (filterPath && path !== filterPath) continue;
    const first = thread.messages[0];
    const rest = thread.messages.slice(1);
    const latest = thread.messages.reduce((value, message) => Math.max(value, message.timestamp), 0);
    comments.push({
      id: thread.id, origin: "overleaf", path,
      ...anchorResult(options.currentSources?.get(path), anchor.position, anchor.quote),
      quote: bounded(anchor.quote, MAX_QUOTE), body: bounded(first.content, MAX_BODY),
      authorName: bounded(first.authorName, 300), resolved: thread.resolved,
      replies: capReplies(rest.map((message) => ({
        authorName: message.authorName,
        body: message.content,
        createdAt: new Date(message.timestamp).toISOString(),
      }))),
      updatedAt: new Date(latest).toISOString(),
    });
  }

  comments.sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from || a.id.localeCompare(b.id));
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const page = comments.slice(offset, offset + limit);
  const boundedPage: AgentComment[] = [];
  let bytes = 0;
  for (const comment of page) {
    const size = new TextEncoder().encode(JSON.stringify(comment)).length;
    if (bytes + size > MAX_SNAPSHOT_BYTES) break;
    bytes += size;
    boundedPage.push(comment);
  }
  const omittedCount = unrepresentable + (comments.length - boundedPage.length);
  const consumed = Math.min(comments.length, offset + boundedPage.length);
  return {
    workspaceRoot: options.workspaceRoot,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    comments: boundedPage,
    omittedCount,
    overleaf: { ...options.overleaf },
    totalCount: comments.length,
    offset,
    nextOffset: consumed < comments.length ? consumed : null,
  };
}

/** Refresh both remote halves together; a partial response is not a fresh snapshot. */
export async function readAgentCommentsSnapshot(options: BuildAgentCommentsOptions): Promise<AgentCommentsPage> {
  if (options.overleaf.status === "not-linked") return buildAgentCommentsSnapshot(options);
  try {
    const [overleafThreads, overleafAnchors] = await Promise.all([
      invoke<OverleafThread[]>("overleaf_threads", { projectRoot: options.workspaceRoot }),
      invoke<OverleafCommentAnchor[]>("overleaf_comment_anchors", { projectRoot: options.workspaceRoot }),
    ]);
    return buildAgentCommentsSnapshot({
      ...options, overleafThreads, overleafAnchors,
      overleaf: { status: "fresh", fetchedAt: new Date().toISOString() },
    });
  } catch (error) {
    return buildAgentCommentsSnapshot({
      ...options,
      overleaf: { status: "unavailable", error: bounded(String(error), 500) },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseAgentEditorCommentsToolRequest(value: unknown): AgentEditorCommentsToolRequest | null {
  if (!isRecord(value) || !onlyKeys(value, ["type", "version", "id", "workspaceRoot", "args", "expiresAt"])
    || value.type !== SYNARA_EDITOR_COMMENTS_TOOL_REQUEST || value.version !== 1
    || typeof value.id !== "string" || !value.id || value.id.length > 128
    || typeof value.workspaceRoot !== "string" || !value.workspaceRoot.trim() || value.workspaceRoot.length > 4_096
    || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)
    || !isRecord(value.args) || !onlyKeys(value.args, ["path", "includeResolved", "offset", "limit"])) return null;
  const { path, includeResolved, offset, limit } = value.args;
  if ((path !== undefined && (typeof path !== "string" || path.length > 1_024 || path.includes("\\") || normalizedPath(path) === null))
    || (includeResolved !== undefined && typeof includeResolved !== "boolean")
    || (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 0))
    || (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100))) return null;
  return value as AgentEditorCommentsToolRequest;
}

export async function executeAgentEditorCommentsToolRequest(
  request: AgentEditorCommentsToolRequest,
  activeWorkspaceRoot: () => string | null,
  read: (request: AgentEditorCommentsToolRequest) => Promise<AgentCommentsPage>,
): Promise<AgentEditorCommentsToolResult> {
  const fail = (code: string, message: string): AgentEditorCommentsToolResult => ({
    type: LATTICE_EDITOR_COMMENTS_TOOL_RESULT, version: 1, id: request.id, ok: false,
    error: { code, message: message.slice(0, 2_000) },
  });
  if (request.expiresAt <= Date.now()) return fail("editor_comments_tool_expired", "The editor comments request expired before execution.");
  if (activeWorkspaceRoot() !== request.workspaceRoot) return fail("editor_comments_workspace_mismatch", "The active workspace does not match the requested workspace.");
  try {
    const result = await read(request);
    if (request.expiresAt <= Date.now()) return fail("editor_comments_tool_expired", "The editor comments request expired during execution.");
    if (activeWorkspaceRoot() !== request.workspaceRoot || result.workspaceRoot !== request.workspaceRoot) {
      return fail("editor_comments_workspace_mismatch", "The active workspace changed while comments were read.");
    }
    return { type: LATTICE_EDITOR_COMMENTS_TOOL_RESULT, version: 1, id: request.id, ok: true, result };
  } catch (error) {
    return fail("editor_comments_read_failed", error instanceof Error ? error.message : String(error));
  }
}
