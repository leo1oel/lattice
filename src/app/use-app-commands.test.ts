import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";
import { commandKeys, paletteEntries, useAppCommands, type AppCommand } from "./use-app-commands";

describe("app commands", () => {
  it("lists the labelled commands it can run, each with keycaps from its own key or the one bound elsewhere", () => {
    const commands: AppCommand[] = [
      { id: "find", label: "Find in project", detail: "source files and papers", key: "f", shift: true, run: () => {} },
      { id: "settings", label: "Open settings", key: ",", run: () => {} },
      { id: "table", label: "Insert table", detail: "Grid generator", run: () => {} },
      { id: "frame", label: "Maximize focused panel", shortcut: { key: "Enter", mod: true, shift: true }, run: () => {} },
      { id: "hidden", label: "Hidden", when: false, run: () => {} },
      { id: "palette", label: "Command palette", key: "p", shift: true, palette: false, run: () => {} },
    ];
    expect(paletteEntries(commands).map(({ id, detail }) => [id, detail])).toEqual([
      ["find", "source files and papers"],
      ["settings", undefined],
      ["table", "Grid generator"],
      ["frame", undefined],
    ]);
    expect(paletteEntries(commands).map(commandKeys)).toEqual([["⌘", "⇧", "F"], ["⌘", ","], null, ["⌘", "⇧", "↩"]]);
    expect(commandKeys({ key: "f8", mod: false })).toEqual(["F8"]);
    expect(commandKeys({})).toBeNull();
  });

  it("runs a key with ⌘ or Ctrl, a lone key without, and ⌘? however the keyboard reports it", () => {
    const run = { save: vi.fn(), next: vi.fn(), previous: vi.fn(), sheet: vi.fn() };
    renderHook(() => useAppCommands([
      { id: "save", key: "s", run: run.save },
      { id: "next", key: "f8", mod: false, run: run.next },
      { id: "previous", key: "f8", shift: true, mod: false, run: run.previous },
      { id: "sheet", key: "?", shift: true, run: run.sheet },
    ]));
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.keyDown(window, { key: "s" });
    fireEvent.keyDown(window, { key: "s", metaKey: true, altKey: true });
    expect(run.save).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "F8" });
    fireEvent.keyDown(window, { key: "F8", shiftKey: true });
    fireEvent.keyDown(window, { key: "F8", metaKey: true });
    expect(run.next).toHaveBeenCalledOnce();
    expect(run.previous).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: "?", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "/", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    expect(run.sheet).toHaveBeenCalledTimes(2);
  });
});
