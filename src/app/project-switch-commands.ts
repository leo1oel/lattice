/**
 * The command table's ways to another project: a folder or a recent project
 * (a window of its own once this one shows a project, or, asked for, this
 * window), the welcome desk's ⌘1 to ⌘3, and ⌃Tab and ⌃⇧Tab round the
 * projects in this window (window-projects.ts). ⌘1 to ⌘9 stay the layout
 * workspaces', so the projects in a window take keys of their own.
 */
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { welcomeDeskProjects } from "../project/first-pages";
import type { RecentProject } from "../settings/app-settings";
import { spaceMixedScript } from "../trellis/trellis-titles";
import type { AppCommand } from "./use-app-commands";
import { windowProjects } from "./window-projects";
import type { useProjectLifecycle } from "./use-project-lifecycle";

type Lifecycle = Pick<
  ReturnType<typeof useProjectLifecycle>,
  "recentProjects" | "unopenedProject" | "chooseExisting" | "chooseRecentProject" | "openInThisWindow"
>;

export function projectSwitchCommands({ i18n, root, lifecycle, deskKeys }: {
  i18n: I18n;
  /** The project this window shows, if any. */
  root: string | null;
  lifecycle: Lifecycle;
  /** Nothing on the welcome screen takes its digits (a dialog, a busy open), so they open its projects. */
  deskKeys: boolean;
}): AppCommand[] {
  const { recentProjects, unopenedProject, chooseExisting, chooseRecentProject, openInThisWindow } = lifecycle;
  const inProject = root !== null;
  const others = recentProjects.filter((recent) => recent.path !== root);
  // Read, not subscribed: App renders with each project it enters, which is
  // when the list grows, and a key press reads the list as it is by then.
  const neighbour = (by: number) => {
    const list = windowProjects.get();
    const at = list.findIndex((entry) => entry.root === root);
    return at < 0 || list.length < 2 ? null : list[(at + by + list.length) % list.length].root;
  };
  const cycles = inProject && neighbour(1) !== null;
  const go = (by: number) => {
    const next = neighbour(by);
    if (next) void openInThisWindow(next);
  };
  return [
    { id: "open-folder-here", when: inProject, label: i18n._(msg`Open a folder in this window`), group: "project", run: () => void chooseExisting(true) },
    ...others.map(({ name, path }, index): AppCommand => ({
      id: `recent-project-${index}`, label: spaceMixedScript(i18n._(msg`Open ${name}`)), detail: path, group: "project",
      // Ids by position, so no path is remembered; and never in Recent, where a position may name another project.
      recent: false,
      run: () => void chooseRecentProject(path),
    })),
    ...(inProject ? others : []).map(({ name, path }: RecentProject, index): AppCommand => ({
      id: `recent-project-here-${index}`, label: spaceMixedScript(i18n._(msg`Open ${name} in this window`)), detail: path,
      group: "project", recent: false,
      run: () => void openInThisWindow(path),
    })),
    // ⌘1 to ⌘3 on the welcome screen: the projects on its desk, by place. In a
    // project the same keys switch workspaces, so these are only listed here.
    ...(inProject ? [] : welcomeDeskProjects(recentProjects, unopenedProject?.path).map(({ path }, index): AppCommand => ({
      id: `desk-project-${index + 1}`, label: i18n._(msg`Open a recent project by its place`), group: "project", key: String(index + 1),
      palette: false, when: deskKeys,
      run: () => void chooseRecentProject(path),
    }))),
    {
      id: "next-window-project", when: cycles, label: i18n._(msg`Next project in this window`), group: "project",
      key: "tab", ctrl: true, palette: false, run: () => go(1),
    },
    {
      id: "previous-window-project", when: cycles, label: i18n._(msg`Previous project in this window`), group: "project",
      key: "tab", ctrl: true, shift: true, palette: false, run: () => go(-1),
    },
  ];
}
