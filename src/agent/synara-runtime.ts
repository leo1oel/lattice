import { hasOnlyKeys, isRecord, isWorkspaceRelativePath } from "./agent-protocol";

type SynaraRuntimeState = "starting" | "ready" | "stopped";

export interface SynaraRuntimeInfo {
  state: SynaraRuntimeState;
  origin: string | null;
  authToken: string | null;
  message: string | null;
  startupMs: number | null;
  version: string | null;
  revision: string | null;
}

export const EMPTY_SYNARA_RUNTIME: SynaraRuntimeInfo = {
  state: "starting",
  origin: null,
  authToken: null,
  message: null,
  startupMs: null,
  version: null,
  revision: null,
};

export const LATTICE_PROJECT_HISTORY = "lattice:project-history";
export const LATTICE_RESTORE_AGENT_CHECKPOINT = "lattice:restore-agent-checkpoint";
export const LATTICE_AGENT_COMPILE_RESULT = "lattice:agent-compile-result";

export interface AgentCompileResultMessage {
  type: typeof LATTICE_AGENT_COMPILE_RESULT;
  version: 1;
  threadId: string;
  turnId: string;
  checkpointRef: string;
  compiledAt: string;
  success: boolean;
  durationMs: number | null;
  rootDocument: string | null;
  diagnostics: { errors: number; warnings: number };
}

const COMPILE_RESULT_KEYS = ["type", "version", "threadId", "turnId", "checkpointRef", "compiledAt", "success", "durationMs", "rootDocument", "diagnostics"];

export function parseAgentCompileResultMessage(value: unknown): AgentCompileResultMessage | null {
  if (!isRecord(value) || !hasOnlyKeys(value, COMPILE_RESULT_KEYS)) return null;
  const { diagnostics, durationMs } = value;
  const rootDocument = typeof value.rootDocument === "string"
    ? value.rootDocument.replace(/\\/g, "/")
    : value.rootDocument;
  if (value.type !== LATTICE_AGENT_COMPILE_RESULT || value.version !== 1
    || !boundedCorrelationId(value.threadId)
    || !boundedCorrelationId(value.turnId)
    || !boundedCorrelationId(value.checkpointRef)
    || !strictUtcTimestamp(value.compiledAt)
    || typeof value.success !== "boolean"
    || !(durationMs === null || (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0))
    || !(rootDocument === null || projectRelativePath(rootDocument))
    || !isRecord(diagnostics) || !hasOnlyKeys(diagnostics, ["errors", "warnings"])
    || !finiteNonNegativeInteger(diagnostics.errors)
    || !finiteNonNegativeInteger(diagnostics.warnings)) return null;
  return {
    ...value,
    rootDocument,
    diagnostics: { errors: diagnostics.errors, warnings: diagnostics.warnings },
  } as AgentCompileResultMessage;
}

export type AgentGitWorkspaceView = "changes" | "pull-requests";

export function agentGitWorkspacePath(view: AgentGitWorkspaceView): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Synara route paths
  return view === "pull-requests" ? "/pull-requests/" : "/source-control";
}

interface AgentCheckpointFileSummary {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
}

export interface AgentCheckpointHistoryEntry {
  id: string;
  label: string;
  timestamp: string;
  threadId: string;
  threadTitle: string;
  turnId: string;
  turnCount: number;
  checkpointRef: string;
  files: AgentCheckpointFileSummary[];
}

export interface AgentProjectHistorySnapshot {
  type: typeof LATTICE_PROJECT_HISTORY;
  activeThreadId: string;
  entries: AgentCheckpointHistoryEntry[];
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function boundedCorrelationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(value);
}

function projectRelativePath(value: unknown): value is string {
  return isWorkspaceRelativePath(value)
    && !value.includes("\0")
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function strictUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  // eslint-disable-next-line lingui/no-unlocalized-strings -- ISO 8601 UTC designator
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function agentCheckpointFileSummary(value: unknown): value is AgentCheckpointFileSummary {
  return isRecord(value)
    && projectRelativePath(value.path)
    && typeof value.kind === "string"
    && finiteNonNegativeInteger(value.additions)
    && finiteNonNegativeInteger(value.deletions);
}

function agentCheckpointHistoryEntry(value: unknown): value is AgentCheckpointHistoryEntry {
  return isRecord(value)
    && boundedCorrelationId(value.id)
    && typeof value.label === "string"
    && strictUtcTimestamp(value.timestamp)
    && boundedCorrelationId(value.threadId)
    && typeof value.threadTitle === "string"
    && boundedCorrelationId(value.turnId)
    && finiteNonNegativeInteger(value.turnCount)
    && boundedCorrelationId(value.checkpointRef)
    && Array.isArray(value.files)
    && value.files.every(agentCheckpointFileSummary);
}

export function parseAgentProjectHistorySnapshot(
  value: unknown,
): AgentProjectHistorySnapshot | null {
  if (
    !isRecord(value)
    || value.type !== LATTICE_PROJECT_HISTORY
    || !boundedCorrelationId(value.activeThreadId)
    || !Array.isArray(value.entries)
    || !value.entries.every(agentCheckpointHistoryEntry)
  ) {
    return null;
  }
  return value as unknown as AgentProjectHistorySnapshot;
}

export function normalizeSynaraOrigin(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//;

function decodeFileReference(value: string): string | null {
  if (!value.toLowerCase().startsWith("file:")) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/**
 * Convert a file reference from the embedded Agent into the project-relative
 * path accepted by Lattice's file commands. Synara normally sends a relative
 * path, but authored Markdown links can retain an absolute or encoded path.
 */
export function synaraProjectRelativeFilePath(
  filePath: unknown,
  projectRoot: string | null | undefined,
): string | null {
  if (typeof filePath !== "string" || !projectRoot?.trim()) return null;
  const decoded = decodeFileReference(filePath.trim());
  if (!decoded) return null;

  /* eslint-disable lingui/no-unlocalized-strings -- Unicode normalization form */
  const target = decoded
    .replace(/\\/g, "/")
    .replace(FILE_POSITION_SUFFIX_PATTERN, "")
    .normalize("NFC");
  const root = projectRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC");
  /* eslint-enable lingui/no-unlocalized-strings */
  if (!root || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(target)) return null;
  const absolute = target.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(target);
  const caseInsensitive = WINDOWS_ABSOLUTE_PATH_PATTERN.test(root);
  const comparisonTarget = caseInsensitive ? target.toLowerCase() : target;
  const comparisonRoot = caseInsensitive ? root.toLowerCase() : root;

  let relative = target.replace(/^\.\//, "");
  if (absolute) {
    const prefix = `${comparisonRoot}/`;
    if (!comparisonTarget.startsWith(prefix)) return null;
    relative = target.slice(root.length + 1);
  }
  if (
    !relative
    || relative.includes("\0")
    || relative.startsWith("/")
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(relative)
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  return relative;
}

export function synaraFrameUrl(input: {
  origin: string;
  path?: string;
  workspaceRoot: string;
  theme: "light" | "dark";
  locale?: "en" | "zh-CN";
  surface?: "chrome" | "drawer";
  hostOrigin: string;
  authToken?: string | null;
  section?: string | null;
}): string {
  const url = new URL(input.path || "/", input.origin);
  url.searchParams.set("embed", "1");
  url.searchParams.set("workspaceRoot", input.workspaceRoot);
  url.searchParams.set("theme", input.theme);
  if (input.locale) url.searchParams.set("locale", input.locale);
  if (input.surface) url.searchParams.set("surface", input.surface);
  url.searchParams.set("hostOrigin", input.hostOrigin);
  if (input.section) url.searchParams.set("section", input.section);
  if (input.authToken) {
    url.hash = new URLSearchParams({ "lattice-auth": input.authToken }).toString();
  }
  return url.toString();
}
