// Validation and reply plumbing shared by the Synara host bridges. Every bridge
// speaks a correlated postMessage protocol with the embedded Agent runtime:
// the field names, error codes, and size bounds here are part of that wire
// contract. Kept free of heavy imports: App.tsx loads the bridges eagerly.
import type { RefObject } from "react";
import { isRecord, toMessage } from "../app-utils";

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** UTF-8 size of the JSON encoding, or null when the value cannot be serialized. */
export function jsonBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

export function isNonBlankString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/** Trimmed and truncated to `maximum`; an empty result is null unless `allowEmpty`. */
export function boundedString(value: unknown, maximum: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, maximum);
  if (normalized) return normalized;
  return allowEmpty ? "" : null;
}

/** A normalized project-relative path: no absolute, drive, backslash, empty, `.` or `..` segment. */
export function isWorkspaceRelativePath(path: unknown, maxLength = 1_024): path is string {
  return typeof path === "string"
    && path.length > 0
    && path.length <= maxLength
    && !path.startsWith("/")
    && !/^[A-Za-z]:/.test(path)
    && !path.includes("\\")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function toolError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Accepts `value` only as a version-1 request of `type` with a bounded
 * correlation id and a finite deadline. When `fields` is given, the envelope
 * may carry nothing beyond the common fields and those.
 */
export function parseToolEnvelope(
  value: unknown,
  type: string,
  fields?: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value) || (fields && !hasOnlyKeys(value, ["type", "version", "id", "expiresAt", ...fields]))) return null;
  if (value.type !== type || value.version !== 1) return null;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) return null;
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
  return value;
}

export type AgentToolResult<Type extends string, Result = unknown> = {
  type: Type;
  version: 1;
  id: string;
  ok: boolean;
  result?: Result;
  error?: { code: string; message: string };
};

/**
 * Runs one tool request and replies with its result, or with the thrown
 * error's `code` (else `fallbackCode`) and message. `boundError` caps both to
 * the sizes the runtime accepts.
 */
export async function runAgentTool<Type extends string, Result>(
  type: Type,
  id: string,
  fallbackCode: string,
  run: () => Result | Promise<Result>,
  boundError = true,
): Promise<AgentToolResult<Type, Result>> {
  try {
    return { type, version: 1, id, ok: true, result: await run() };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : fallbackCode;
    const message = toMessage(error);
    return {
      type,
      version: 1,
      id,
      ok: false,
      error: boundError ? { code: code.slice(0, 128), message: message.slice(0, 2_000) } : { code, message },
    };
  }
}

/** Promises that settle when the editor for a path registers with a bridge. */
export function createOpenWaiters() {
  type Waiter = { resolve: () => void; timer: ReturnType<typeof setTimeout> };
  const waiters = new Map<string, Set<Waiter>>();
  return {
    notify(path: string): void {
      const pending = waiters.get(path);
      if (!pending) return;
      waiters.delete(path);
      for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    },
    wait(path: string, timeoutMs: number, isOpen: boolean, timeoutMessage: string): Promise<void> {
      if (isOpen) return Promise.resolve();
      const timeout = () => toolError(timeoutMessage, "project_document_open_timeout");
      if (timeoutMs <= 0) return Promise.reject(timeout());
      return new Promise((resolve, reject) => {
        const pending = waiters.get(path) ?? new Set<Waiter>();
        const waiter: Waiter = {
          resolve,
          timer: setTimeout(() => {
            pending.delete(waiter);
            if (pending.size === 0) waiters.delete(path);
            reject(timeout());
          }, timeoutMs),
        };
        pending.add(waiter);
        waiters.set(path, pending);
      });
    },
  };
}

/**
 * Delivers window messages from the embedded Synara frame only: both the
 * message source and the origin must match before any content is trusted.
 */
export function listenToSynaraFrame(
  frameRef: RefObject<HTMLIFrameElement | null>,
  origin: string,
  receive: (data: unknown, source: Window) => void,
): () => void {
  const listener = (event: MessageEvent) => {
    if (event.source !== frameRef.current?.contentWindow || event.origin !== origin) return;
    receive(event.data, event.source as Window);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
