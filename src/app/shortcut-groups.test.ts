import { describe, expect, it } from "vitest";
import { i18n } from "@lingui/core";
import { DEFAULT_KEYMAP } from "@danfessler/trellis";
import { filterShortcutGroups, shortcutGroups } from "./shortcut-groups";
import { parseKeyName } from "./key-combos";
import { FRAME_TOGGLE_KEY, TRELLIS_KEYMAP } from "../trellis/trellis-keymap";
import type { AppCommand } from "./use-app-commands";

const run = () => {};
const commands: AppCommand[] = [
  { id: "save", label: "Save and build", group: "build", key: "s", palette: false, run },
  { id: "build", label: "Build project", group: "build", run },
  ...Array.from({ length: 9 }, (_, index): AppCommand => ({
    id: `workspace-${index + 1}`, label: "Switch to a workspace by its place", group: "layout", key: String(index + 1), run,
  })),
  { id: "focus-mode", label: "Focus mode", group: "layout", key: "d", shift: true, when: false, run },
  { id: "next-problem", label: "Next build problem", group: "navigate", key: "f8", mod: false, run },
];

describe("the shortcut sheet's groups", () => {
  const groups = shortcutGroups(commands, i18n);
  const group = (id: string) => groups.find((entry) => entry.id === id)!;

  it("lists every keyed command under its group, those sharing a label as one range", () => {
    expect(groups.map((entry) => entry.title).slice(0, 3)).toEqual(["Build", "Layout", "Navigate"]);
    expect(group("app-Build").rows).toEqual([{ label: "Save and build", combos: [["⌘", "S"]] }]);
    expect(group("app-Layout").rows).toEqual([
      { label: "Switch to a workspace by its place", combos: Array.from({ length: 9 }, (_, index) => ["⌘", String(index + 1)]), range: true },
      { label: "Focus mode", combos: [["⌘", "⇧", "D"]] },
      { label: "Leave focus mode", combos: [["Esc"]] },
    ]);
    expect(group("app-Navigate").rows).toEqual([{ label: "Next build problem", combos: [["F8"]] }]);
  });

  it("lists the workspace's keys as Lattice configures Trellis", () => {
    const tabs = group("panels").rows.find((row) => row.label === "Previous or next tab");
    expect(tabs?.combos).toEqual([["⌘", "⇧", "["], ["⌘", "⇧", "]"]]);
    expect(group("panels").rows.map((row) => row.label)).not.toContain("Overview");
  });

  it("lists the editors' own keys", () => {
    expect(group("latex").rows).toContainEqual({ label: "Wrap in environment…", combos: [["⌘", "⇧", "E"]] });
    expect(group("latex").rows).toContainEqual({ label: "Replace all (in the find bar)", combos: [["⌘", "⌥", "A"]] });
    expect(group("markdown").rows).toContainEqual(expect.objectContaining({ label: "Heading 1 to 6", range: true }));
    expect(group("editor").rows).toContainEqual({ label: "Undo", combos: [["⌘", "Z"]] });
  });

  it("filters by name or by key, keeping a whole group whose title matches", () => {
    expect(filterShortcutGroups(groups, "focus mode").flatMap((entry) => entry.rows.map((row) => row.label)))
      .toEqual(["Focus mode", "Leave focus mode"]);
    expect(filterShortcutGroups(groups, "⌘⇧d").flatMap((entry) => entry.rows.map((row) => row.label))).toContain("Focus mode");
    expect(filterShortcutGroups(groups, "latex").map((entry) => entry.id)).toContain("latex");
    expect(filterShortcutGroups(groups, "no such key")).toEqual([]);
  });
});

describe("keys the palette shows for Trellis", () => {
  it("names Trellis's own maximize key", () => {
    expect(parseKeyName({ ...DEFAULT_KEYMAP, ...TRELLIS_KEYMAP }["frame.toggle"]!)).toEqual(FRAME_TOGGLE_KEY);
  });
});

