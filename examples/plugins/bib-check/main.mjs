// SPDX-License-Identifier: MIT
import { check } from "./check.mjs";
import { definePlugin } from "./lattice-plugin.mjs";

definePlugin({
  commands: {
    async check({ host }) {
      host.progress("Reading the bibliography");
      const { files } = await host.bibliographyEntries();
      const items = check(files);
      const entries = files.reduce((n, f) => n + f.entries.length, 0);
      const problems = items.filter((d) => d.severity !== "info").length;
      const summary =
        files.length === 0
          ? "This project has no .bib file."
          : `${entries} entries in ${files.length} file${files.length === 1 ? "" : "s"}: ${problems === 0 ? "no problems" : `${problems} problem${problems === 1 ? "" : "s"}`}.`;
      return { kind: "diagnostics", summary, items };
    },
  },
});
