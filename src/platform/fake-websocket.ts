import { expect, vi } from "vitest";

/** Test double for the loopback bridge sockets; every instance is recorded in `sockets`. */
export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    sockets.push(this);
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  disconnect(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

export const sockets: FakeWebSocket[] = [];

export function lastSocket(): FakeWebSocket {
  expect(sockets.length).toBeGreaterThan(0);
  return sockets.at(-1)!;
}
