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
};

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
