/** Every window shares one localStorage; a second hook here is a second window's Settings. */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCommentAuthor } from "./use-comment-author";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("shows the name another window saved", () => {
  const windowA = renderHook(() => useCommentAuthor(undefined, false));
  const windowB = renderHook(() => useCommentAuthor(undefined, false));

  act(() => windowA.result.current.changeSetting("Ada Lovelace "));
  expect(windowA.result.current.setting).toBe("Ada Lovelace ");
  expect(windowA.result.current.name).toBe("Ada Lovelace");
  expect(localStorage.getItem("lattice.author-name.v1")).toBe("Ada Lovelace ");

  const oldValue = localStorage.getItem("lattice.author-name.v1");
  localStorage.setItem("lattice.author-name.v1", "Grace Hopper");
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: "lattice.author-name.v1", oldValue, newValue: "Grace Hopper" }));
  });
  expect(windowA.result.current.name).toBe("Grace Hopper");
  expect(windowB.result.current.setting).toBe("Grace Hopper");
});

it("keeps each keystroke of the name, spaces included, and signs it trimmed", () => {
  const { result } = renderHook(() => useCommentAuthor(undefined, false));
  for (const typed of ["A", "Ad", "Ada", "Ada ", "Ada L"]) {
    act(() => result.current.changeSetting(typed));
    expect(result.current.setting).toBe(typed);
    expect(result.current.name).toBe(typed.trim());
  }
});
