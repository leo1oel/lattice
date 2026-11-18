/**
 * The command table's named workspaces (trellis-workspaces.ts): each by name,
 * ⌘1 to ⌘9 by place, and making, saving and reverting one.
 */
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { TrellisController } from "../trellis/trellis-controller";
import { spaceMixedScript } from "../trellis/trellis-titles";
import { WORKSPACE_SHORTCUTS } from "../trellis/trellis-workspaces";
import type { AppCommand } from "./use-app-commands";

/** Each by name in the palette, and ⌘1 to ⌘9 by position (read when pressed, so a reorder counts at once). */
export function workspaceSwitchCommands(i18n: I18n, trellis: TrellisController, inProject: boolean): AppCommand[] {
  return [
    ...trellis.workspaces.list().map(({ id, name }, index): AppCommand => ({
      id: `workspace-${id}`, when: inProject, label: spaceMixedScript(i18n._(msg`Switch to ${name}`)), group: "layout",
      shortcut: index < WORKSPACE_SHORTCUTS ? { key: String(index + 1), mod: true } : undefined,
      run: () => trellis.switchWorkspace(id),
    })),
    ...Array.from({ length: WORKSPACE_SHORTCUTS }, (_, index): AppCommand => ({
      id: `workspace-${index + 1}`, when: inProject, label: i18n._(msg`Switch to a workspace by its place`), group: "layout", key: String(index + 1), palette: false,
      run: () => trellis.switchWorkspaceAt(index),
    })),
  ];
}

/** New workspace, and Save to workspace and Revert while the project's layout differs from its workspace's saved arrangement. */
export function workspaceEditCommands(i18n: I18n, trellis: TrellisController, inProject: boolean, dirty: boolean): AppCommand[] {
  return [
    { id: "workspace-new", when: inProject, label: i18n._(msg`New workspace`), group: "layout", run: () => void trellis.createWorkspace(i18n._(msg`Workspace`)) },
    ...(dirty ? [
      { id: "workspace-save", when: inProject, label: i18n._(msg`Save to workspace`), group: "layout" as const, run: () => trellis.saveWorkspace() },
      { id: "workspace-revert", when: inProject, label: i18n._(msg`Revert to saved`), group: "layout" as const, recent: false as const, run: () => trellis.revertWorkspace() },
    ] : []),
  ];
}
