import { beforeEach, expect, it } from "vitest";
import { persistSynaraThread, synaraEmbedUrl } from "./app-synara-embed";

beforeEach(() => localStorage.clear());

it("restores each project's own conversation even when the sidecar port changes", () => {
  persistSynaraThread("/projects/first", "first-thread");
  persistSynaraThread("/projects/second", "second-thread");
  for (const origin of ["http://127.0.0.1:4173", "http://127.0.0.1:49152"]) {
    const url = new URL(synaraEmbedUrl(origin, "token", "/projects/first", "light", "en"));
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/first-thread");
    expect(url.searchParams.get("workspaceRoot")).toBe("/projects/first");
    expect(url.searchParams.get("embed")).toBe("1");
    expect(url.hash).toBe("#lattice-auth=token");
  }
  expect(new URL(synaraEmbedUrl("http://127.0.0.1:4173", null, "/projects/second", "dark", "zh-CN")).pathname)
    .toBe("/second-thread");
  expect(new URL(synaraEmbedUrl("http://127.0.0.1:4173", null, "/projects/new", "light", "en")).pathname)
    .toBe("/");
});

it("encodes thread identifiers as a single route segment", () => {
  persistSynaraThread("/project", "draft/thread:1");
  expect(new URL(synaraEmbedUrl("http://127.0.0.1:4173", null, "/project", "light", "en")).pathname)
    .toBe("/draft%2Fthread%3A1");
});
