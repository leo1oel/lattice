import { beforeEach, expect, it } from "vitest";
import { persistSynaraThread, synaraEmbedUrl } from "./app-synara-embed";

beforeEach(() => localStorage.clear());

const embedPath = (projectRoot: string, theme: "light" | "dark" = "light", locale: "en" | "zh-CN" = "en") =>
  new URL(synaraEmbedUrl({ origin: "http://127.0.0.1:4173", authToken: null, projectRoot, theme, locale })).pathname;

it("restores each project's own conversation even when the sidecar port changes", () => {
  persistSynaraThread("/projects/first", "first-thread");
  persistSynaraThread("/projects/second", "second-thread");
  for (const origin of ["http://127.0.0.1:4173", "http://127.0.0.1:49152"]) {
    const url = new URL(synaraEmbedUrl({ origin, authToken: "token", projectRoot: "/projects/first", theme: "light", locale: "en" }));
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/first-thread");
    expect(url.searchParams.get("workspaceRoot")).toBe("/projects/first");
    expect(url.searchParams.get("embed")).toBe("1");
    expect(url.hash).toBe("#lattice-auth=token");
  }
  expect(embedPath("/projects/second", "dark", "zh-CN")).toBe("/second-thread");
  expect(embedPath("/projects/new")).toBe("/");
});

it("encodes thread identifiers as a single route segment", () => {
  persistSynaraThread("/project", "draft/thread:1");
  expect(embedPath("/project")).toBe("/draft%2Fthread%3A1");
});
