/**
 * Every window shares one localStorage. A choice the writer makes once for
 * every window — in Settings or anywhere else — belongs in a `sharedSetting`
 * (shared-setting.ts): a window that reads it once and writes it back later
 * shows a stale choice, acts on it, and undoes another window's change.
 *
 * These lists name every other write to storage, and why it may stay one.
 * A new entry fails here until it is a `sharedSetting` or says why not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** `persistSetting(KEY, …)`: the key, and why one window's copy is enough. */
const PERSISTED_KEYS: Record<string, string> = {
  RECENT_PROJECTS_KEY: "a history: storage is read again just before each write",
  RECENT_COMMANDS_KEY: "a history: storage is read again just before each write",
  RECENT_KEY: "the recent selection instructions, a history read again just before each write",
  TUTORIAL_SEEN_KEY: "a one-way flag",
  SETTINGS_TAB_KEY: "where this window last left Settings",
  SPLIT_RATIO_KEY: "this window's layout, which the next window starts from",
  BIB_LIST_RATIO_KEY: "this window's layout, which the next window starts from",
  SUBMISSION_TEMPLATES_KEY: "follow-up: saved whole from the list this window loaded",
  LAST_KEY: "the highlighter pen this window last used",
  CUSTOM_KEY: "follow-up: highlighters.ts saves its custom colours from this window's copy",
  MEANINGS_KEY: "follow-up: highlighters.ts saves the meanings from this window's copy",
};

/** Files that call `setItem` on storage themselves, and why. */
const DIRECT_WRITERS: Record<string, string> = {
  "settings/shared-setting.ts": "the shared setting itself",
  "settings/app-settings.ts": "per-project maps and the live preview choice, read again just before each write",
  "app/app-synara-embed.ts": "each project's agent thread",
  "app/whats-new.ts": "the version this install last ran",
  "app/pdf-window-state.ts": "each project's PDF window, open or not and where it was left, read again just before each write",
  "platform/browser-host-bridge.ts": "seeds a browser preview's storage",
  "platform/browser-relay.ts": "seeds a browser preview's storage",
  "platform/perf-lab-harness.ts": "seeds the perf lab's storage",
  "overleaf/margin-review-mode.ts": "keyed by window label: each window's own",
  "pdf/use-pdf-view.ts": "the PDF zoom this window last used, which the next window starts from",
  "project/project-tree-files.ts": "follow-up: the show-hidden-files toggle, read once per tree",
  "project/project-file-tree.tsx": "each project's expanded folders",
  "telemetry/app-log-store.ts": "the app log",
  "build/compile-diagnostics-panel.tsx": "where this window last docked the build log",
  "trellis/trellis-layout.ts": "each project's layout",
  "trellis/trellis-workspaces.ts": "the saved workspace layouts",
  "editor/comments/editor-comment-data.ts": "the comment author id, written once when first needed",
};

const sources = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$|test-utils|app-test-/.test(file))
  .map((file) => ({ file: file.replaceAll("\\", "/"), text: readFileSync(`src/${file}`, "utf8") }));

describe("settings every window shares", () => {
  it("persists only window-local keys outside a sharedSetting", () => {
    const keys = sources.flatMap(({ file, text }) => [...text.matchAll(/(?<!function )\bpersistSetting\(([^,)]*)/g)]
      .map(([, key]) => ({ file, key: key.trim() })));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter(({ key }) => !(key in PERSISTED_KEYS))).toEqual([]);
    expect(Object.keys(PERSISTED_KEYS).filter((listed) => !keys.some(({ key }) => key === listed))).toEqual([]);
  });

  it("writes storage directly only where that is listed", () => {
    const writers = sources.filter(({ text }) => /\b(?:localStorage|storage)\.setItem\(/.test(text)).map(({ file }) => file);
    expect(writers.filter((file) => !(file in DIRECT_WRITERS))).toEqual([]);
    // A writer that is gone takes its entry with it, so the list stays true.
    expect(Object.keys(DIRECT_WRITERS).filter((file) => !writers.includes(file))).toEqual([]);
  });
});
