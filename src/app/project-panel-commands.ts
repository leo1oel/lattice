/**
 * The command palette's Project panel commands: the panel's + menu, which the
 * tree answers with an inline field, and its Refresh.
 */
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { requestProjectTreeRefresh } from "../project/project-files-changed";
import { NEW_ENTRIES, REFRESH_FILE_TREE, type NewEntryType } from "../project/project-new-entries";
import type { TrellisController } from "../trellis/trellis-controller";
import type { AppCommand } from "./use-app-commands";

export function projectPanelCommands({ inProject, i18n, trellis, requestNewEntry }: {
  inProject: boolean;
  i18n: I18n;
  trellis: Pick<TrellisController, "panelState" | "showPanel">;
  requestNewEntry: (type: NewEntryType) => void;
}): AppCommand[] {
  // A panel already on screen keeps focus out of the way; one brought back
  // takes focus a frame later, so the field opens after that.
  return [
    ...NEW_ENTRIES.map(({ type, label }): AppCommand => ({
      id: `new-${type}`, when: inProject, label: i18n._(label), group: "project",
      run: () => {
        const shown = trellis.panelState("project") === "shown";
        trellis.showPanel("project", { focus: false });
        if (shown) requestNewEntry(type);
        else requestAnimationFrame(() => requestAnimationFrame(() => requestNewEntry(type)));
      },
    })),
    {
      id: "refresh-tree", when: inProject, label: i18n._(REFRESH_FILE_TREE), group: "project",
      keywords: i18n._(msg({ message: "reload files folders sync disk", comment: "Search words for the Refresh file tree command, space-separated" })),
      run: requestProjectTreeRefresh,
    },
  ];
}
