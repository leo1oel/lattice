import { describe, expect, it } from "vitest";
import { ShadowText, SourceSync, textChange, utf8Length } from "./rtex-source-sync";

/** Apply rtex byte edits to UTF-8 text, as rtex does. */
function applyBytes(text: string, commands: ReturnType<SourceSync["update"]>): string {
  let bytes = Buffer.from(text, "utf8");
  for (const command of commands) {
    if (command.cmd === "set_document") bytes = Buffer.from(command.text, "utf8");
    else if (command.cmd === "edit") bytes = Buffer.concat([bytes.subarray(0, command.start), Buffer.from(command.text, "utf8"), bytes.subarray(command.end)]);
  }
  return bytes.toString("utf8");
}

describe("live preview source sync", () => {
  it("finds the one changed range, keeping surrogate pairs whole", () => {
    expect(textChange("abc", "abc")).toBeNull();
    expect(textChange("hello world", "hello brave world")).toEqual({ rangeOffset: 6, rangeLength: 0, text: "brave " });
    expect(textChange("a😀b", "a😁b")).toEqual({ rangeOffset: 1, rangeLength: 2, text: "😁" });
    expect(textChange("aaa", "aa")).toEqual({ rangeOffset: 2, rangeLength: 1, text: "" });
  });

  it("counts UTF-8 bytes the way rtex addresses them", () => {
    expect(utf8Length("aé😀中")).toBe(1 + 2 + 4 + 3);
    const shadow = new ShadowText("é😀x");
    expect(shadow.byteOffset(3)).toBe(6);
    expect(shadow.utf16Offset(6)).toBe(3);
  });

  it("turns a typed text into byte edits that rebuild it in rtex's copy", () => {
    const sync = new SourceSync();
    const disk = "Intro — café.\n\nSecond paragraph 😀 here.\n";
    let rtex = disk;
    const steps = [
      "Intro — café!\n\nSecond paragraph 😀 here.\n",
      "Intro — café!\n\nSecond paragraph 😀😀 here.\n",
      "Intro — café!\n\nSecond 中文 paragraph 😀😀 here.\n",
    ];
    for (const text of steps) {
      const commands = sync.update("main.tex", text, disk);
      expect(commands.every((command) => command.cmd === "edit")).toBe(true);
      rtex = applyBytes(rtex, commands);
      expect(rtex).toBe(text);
    }
  });

  it("sends a whole file once when it first differs from disk, and nothing when it matches", () => {
    const sync = new SourceSync();
    expect(sync.update("a.tex", "same", "same")).toEqual([]);
    expect(sync.knows("a.tex")).toBe(true);
    expect(sync.replace("a.tex", "same")).toBeNull();
    expect(sync.replace("a.tex", "changed on disk")).toEqual({ cmd: "set_document", path: "a.tex", text: "changed on disk" });
    // A rewrite of most of a long file goes whole.
    const long = "x".repeat(10_000);
    const sync2 = new SourceSync();
    expect(sync2.update("b.tex", "y".repeat(10_000), long)[0].cmd).toBe("set_document");
  });
});
