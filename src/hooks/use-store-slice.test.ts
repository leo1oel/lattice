import { act, renderHook, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { useStoreSlice } from "./use-store-slice";

type State = { file: string; tabs: string[]; opening: string | null };
const rendered = ({ file, tabs }: State) => ({ file, tabs });

function renderSlice() {
  const store = createStore<State>()(() => ({ file: "", tabs: [], opening: null }));
  const commits: string[] = [];
  const view = renderHook(() => {
    const slice = useStoreSlice(store, rendered);
    const [project, setProject] = useReducer((_: string, next: string) => next, "");
    commits.push(`${project}|${slice.file}`);
    return { slice, setProject };
  });
  return { store, commits, view };
}

describe("useStoreSlice", () => {
  it("commits a store write together with React state set beside it in an async continuation", async () => {
    const { store, commits, view } = renderSlice();
    commits.length = 0;
    // IPC answers outside act, so React picks each update's priority itself:
    // the store write and the state set one await later belong to one update.
    await Promise.resolve().then(async () => {
      store.setState({ file: "main.tex" });
      await Promise.resolve();
      view.result.current.setProject("/paper");
    });
    await waitFor(() => expect(commits.at(-1)).toBe("/paper|main.tex"));
    expect(commits).toEqual(["/paper|main.tex"]);
  });

  it("does not render for fields outside the slice, or for an equal slice", () => {
    const { store, commits } = renderSlice();
    commits.length = 0;
    act(() => store.setState({ opening: "intro.tex" }));
    act(() => store.setState(({ tabs }) => ({ tabs, file: "" })));
    expect(commits).toEqual([]);
  });
});
