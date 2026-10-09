import type { AgentPresentationContext } from "../../agent/agent-host-context";

export type OpenSlideSyncOperation = {
  path: string;
  kind: "create" | "write" | "delete";
  text?: string;
  base64?: string;
};

/** A file change Open Slide saved; `previous*` holds the replaced bytes so a rejected change can be reverted. */
export type OpenSlideMutation = OpenSlideSyncOperation & {
  id: number;
  previousText?: string;
  previousBase64?: string;
};

/** The live deck state the Agent also receives, plus whether the inspector holds unsaved edits. */
export type OpenSlideContext = AgentPresentationContext & { pendingEdits: boolean };

export type OpenSlideEvent = OpenSlideMutation | {
  id: number;
  type: "context";
  context: OpenSlideContext;
} | {
  // Sent once per stream after any replay. `id` is the runtime's current
  // sequence, i.e. the cursor a bridge that has consumed the stream holds.
  id: number;
  type: "ready";
};

// The last event this page's host bridge consumed, per runtime instance. It
// lives outside the workspace component on purpose: remounting a workspace,
// switching which cached deck is active, or reconnecting after a dropped
// stream must all resume from what the page has applied, because the runtime
// only replays a mutation to a stream that names a cursor. A new page starts
// with no cursor, which the runtime treats as a fresh bridge.
const eventCursors = new Map<string, number>();

function eventCursorKey(origin: string, controlToken: string): string {
  return `${origin}\n${controlToken}`;
}

export function openSlideEventCursor(origin: string, controlToken: string): number | undefined {
  return eventCursors.get(eventCursorKey(origin, controlToken));
}

export function advanceOpenSlideEventCursor(
  origin: string,
  controlToken: string,
  event: OpenSlideEvent,
): void {
  const key = eventCursorKey(origin, controlToken);
  // The ready frame is authoritative: it also rewinds a cursor that outlived
  // a runtime restart on the same origin, whose sequence starts over.
  eventCursors.set(
    key,
    "type" in event && event.type === "ready"
      ? event.id
      : Math.max(eventCursors.get(key) ?? 0, event.id),
  );
}

export function __resetOpenSlideEventCursorsForTests(): void {
  eventCursors.clear();
}

// The active deck's refresh of the runtime from disk, per project. It defers
// to Open Slide's unsaved inspector edits and reasserts the editor's bytes
// (see OpenSlideWorkspace), so anything else that needs the runtime to show
// the project's current files refreshes through it while a deck is active.
const activeRefreshes = new Map<string, () => Promise<void>>();

export function registerOpenSlideRefresh(projectRoot: string, refresh: () => Promise<void>): () => void {
  activeRefreshes.set(projectRoot, refresh);
  return () => {
    if (activeRefreshes.get(projectRoot) === refresh) activeRefreshes.delete(projectRoot);
  };
}

export function activeOpenSlideRefresh(projectRoot: string): (() => Promise<void>) | null {
  return activeRefreshes.get(projectRoot) ?? null;
}

/** Feed each server-sent event in `stream` to `onEvent`, in order, until the stream ends. */
export async function consumeOpenSlideEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: OpenSlideEvent) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) await onEvent(JSON.parse(data) as OpenSlideEvent);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) return;
  }
}
