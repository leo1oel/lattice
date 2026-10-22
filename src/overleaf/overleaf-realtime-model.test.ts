import { describe, expect, it } from "vitest";
import { shouldRetryConnection } from "./overleaf-realtime-model";

describe("shouldRetryConnection", () => {
  it.each([
    // What the realtime server says to an account removed from the project,
    // or about a deleted project: retried, it read "Reconnecting in 30 s…" forever.
    "Overleaf rejected joinProject: not authorized",
    "project not found",
    "This Overleaf account can no longer open the project. It may have been removed from the project, or the project deleted.",
    "Overleaf session expired. Reconnect in Settings → Overleaf.",
    "Forbidden",
  ])("gives up on %j", (reason) => expect(shouldRetryConnection(reason)).toBe(false));

  it.each([
    "network unavailable",
    "The Overleaf realtime connection closed before the server answered.",
    "Overleaf refused the realtime handshake (HTTP 502).",
  ])("retries %j", (reason) => expect(shouldRetryConnection(reason)).toBe(true));
});
