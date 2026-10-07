import { describe, expect, it } from "vitest";
import { getExtensionField, resolveExtensions, type AnyExtension } from "@tiptap/core";
import { BlockMoveKeymap } from "./chrome/block-controls";
import { EngineKeymap } from "./engine-keymap";
import { engineSchemaExtensions } from "./engine-schema";
import { ENGINE_SHORTCUTS } from "./engine-shortcuts";

/** Every key the extensions bind, read from their keyboard shortcuts without an editor. */
function boundKeys(extensions: AnyExtension[]): Set<string> {
  const keys = new Set<string>();
  for (const extension of resolveExtensions(extensions)) {
    const shortcuts = getExtensionField<() => Record<string, unknown>>(extension, "addKeyboardShortcuts", {
      name: extension.name, options: extension.options, storage: extension.storage, editor: null, type: null,
    } as never);
    for (const key of Object.keys(shortcuts?.() ?? {})) keys.add(key);
  }
  return keys;
}

describe("the visual Markdown editor's listed keys", () => {
  it("are the keys its extensions bind", () => {
    const bound = boundKeys([...engineSchemaExtensions(), EngineKeymap, BlockMoveKeymap]);
    // Links take their key from the table in the chrome; find is the chrome's own key handler.
    const chromeOwned = new Set(["link", "find", "replace"]);
    for (const [id, { keys }] of Object.entries(ENGINE_SHORTCUTS)) {
      if (chromeOwned.has(id)) continue;
      for (const key of keys) expect(bound, `${id}: ${key}`).toContain(key);
    }
  });
});
