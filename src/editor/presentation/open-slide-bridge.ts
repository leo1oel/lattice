export type OpenSlideMutation = {
  id: number;
  path: string;
  kind: "create" | "write" | "delete";
  text?: string;
  base64?: string;
  previousText?: string;
  previousBase64?: string;
};

export type OpenSlideComment = {
  id: string;
  line: number;
  ts: string;
  note: string;
  hint?: string;
};

export type OpenSlideContext = {
  slideId: string;
  pageIndex: number;
  pageNumber: number;
  totalPages: number;
  slideTitle: string;
  view: "slides" | "assets";
  pagePath: string;
  pendingEdits: boolean;
  pendingComments: OpenSlideComment[];
  selection: {
    line: number;
    column: number;
    tagName: string;
    text: string;
  } | null;
  updatedAt: string;
};

export type OpenSlideEvent = OpenSlideMutation | {
  id: number;
  type: "context";
  context: OpenSlideContext;
};

export type OpenSlideSyncOperation = {
  path: string;
  kind: "create" | "write" | "delete";
  text?: string;
  base64?: string;
};

export async function consumeOpenSlideEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: OpenSlideEvent) => Promise<void>,
): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEventId = 0;
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
      if (data) {
        const event = JSON.parse(data) as OpenSlideEvent;
        await onEvent(event);
        lastEventId = Math.max(lastEventId, event.id);
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) return lastEventId;
  }
}
