import { describe, expect, it, vi } from "vitest";
import {
  consumeOpenSlideEvents,
  type OpenSlideEvent,
} from "./open-slide-bridge";

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
  it("consumes split and adjacent SSE frames and returns the replay id", async () => {
    const onEvent = vi.fn(async (_event: OpenSlideEvent) => undefined);
    const lastEventId = await consumeOpenSlideEvents(chunkedStream([
      ": ready\r",
      "\n\r\nid: 4\r\ndata: {\"id\":4,\"path\":\"slides/a/index.tsx\",",
      "\"kind\":\"write\",\"text\":\"four\"}\r\n\r\nid: 9\ndata: {\"id\":9,",
      "\"path\":\"assets/chart.png\",\"kind\":\"delete\"}\n\n",
    ]), onEvent);

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls.map(([event]) => event.id)).toEqual([4, 9]);
    expect(lastEventId).toBe(9);
  });

  it("passes live presentation context events through without treating them as mutations", async () => {
    const onEvent = vi.fn(async (_event: OpenSlideEvent) => undefined);
    await consumeOpenSlideEvents(chunkedStream([
      "id: 3\ndata: {\"id\":3,\"type\":\"context\",\"context\":{\"slideId\":\"talk\",\"pageIndex\":1,\"pageNumber\":2,\"totalPages\":4,\"slideTitle\":\"Talk\",\"view\":\"slides\",\"pagePath\":\"slides/talk/index.tsx\",\"selection\":null,\"updatedAt\":\"2026-08-30T12:00:00.000Z\"}}\n\n",
    ]), onEvent);

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "context",
      context: expect.objectContaining({ pagePath: "slides/talk/index.tsx", pageNumber: 2 }),
    }));
  });
});
