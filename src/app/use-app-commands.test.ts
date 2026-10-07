import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";
import { commandShortcut, paletteEntries, useAppCommands, type AppCommand } from "./use-app-commands";

describe("app commands", () => {
  it("writes each command's shortcut from its key, ahead of any detail", () => {
    const commands: AppCommand[] = [
      { id: "find", label: "Find in project", detail: "source files and papers", key: "f", shift: true, run: () => {} },
      { id: "settings", label: "Open settings", key: ",", run: () => {} },
      { id: "table", label: "Insert table", detail: "Grid generator", run: () => {} },
      { id: "hidden", label: "Hidden", when: false, run: () => {} },
      { id: "palette", label: "Command palette", key: "p", shift: true, palette: false, run: () => {} },
    ];
    expect(paletteEntries(commands).map(({ id, detail }) => [id, detail])).toEqual([
      ["find", "⌘⇧F · source files and papers"],
      ["settings", "⌘,"],
      ["table", "Grid generator"],
    ]);
    expect(commandShortcut({ key: "f8", mod: false })).toBe("F8");
    expect(commandShortcut({})).toBeNull();
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
