// SPDX-License-Identifier: MIT
import { projectKeys, toItems } from "./items.mjs";
import { definePlugin, PluginError } from "./lattice-plugin.mjs";
import { search, ZoteroUnavailable } from "./zotero.mjs";

definePlugin({
  commands: {
    async search({ input, host }) {
      const query = (input ?? "").trim();
      if (!query) throw new PluginError("Type a title, an author, a year or a citation key.");
      host.progress(`Searching Zotero for “${query}”`);
      let hits;
      try {
        hits = await search(query);
      } catch (error) {
        if (error instanceof ZoteroUnavailable) throw new PluginError(error.message);
        throw error;
      }
      const items = toItems(hits, await projectKeys(host));
      const source = hits[0]?.source ?? "Zotero";
      return {
        kind: "items",
        summary: `${items.length} result${items.length === 1 ? "" : "s"} for “${query}” from ${source}.`,
        items,
      };
    },
  },
});
