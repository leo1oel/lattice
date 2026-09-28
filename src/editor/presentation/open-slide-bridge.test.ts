import { describe, expect, it, vi } from "vitest";
import { consumeOpenSlideEvents, type OpenSlideEvent } from "./open-slide-bridge";

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("consumeOpenSlideEvents", () => {
  it("passes split and adjacent SSE frames, mutations and live context alike, through in order", async () => {
    const onEvent = vi.fn(async (_event: OpenSlideEvent) => undefined);
    await consumeOpenSlideEvents(chunkedStream([
      ": ready\r",
      "\n\r\nid: 4\r\ndata: {\"id\":4,\"path\":\"slides/a/index.tsx\",",
      "\"kind\":\"write\",\"text\":\"four\"}\r\n\r\nid: 9\ndata: {\"id\":9,",
      "\"path\":\"assets/chart.png\",\"kind\":\"delete\"}\n\n",
      "id: 12\ndata: {\"id\":12,\"type\":\"context\",\"context\":{\"pagePath\":\"slides/talk/index.tsx\",\"pageNumber\":2}}\n\n",
    ]), onEvent);

    expect(onEvent.mock.calls.map(([event]) => event.id)).toEqual([4, 9, 12]);
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "context",
      context: expect.objectContaining({ pagePath: "slides/talk/index.tsx", pageNumber: 2 }),
    }));
  });
});
