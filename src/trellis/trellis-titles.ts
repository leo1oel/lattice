/** Panel names, shared by the workspace tabs, the titlebar and the command palette. */
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import type { TrellisSingleton } from "./trellis-controller";

export const PANEL_TITLES: Record<TrellisSingleton, MessageDescriptor> = {
  project: msg`Project`,
  papers: msg`Papers`,
  agent: msg`Agent`,
  pdf: msg`PDF`,
  history: msg`History`,
  git: msg`Source control`,
  comments: msg`Comments`,
  overleaf: msg`Overleaf`,
  literature: msg`Literature`,
  todos: msg`TODOs`,
  checklist: msg`Checklist`,
};

/**
 * Chinese UI copy puts a space between Han characters and Latin words
 * ("在 PDF 中查找"). Names interpolated into a translated phrase ("显示{name}")
 * need the same treatment, whichever script the name is in.
 */
export function spaceMixedScript(text: string): string {
  return text
    .replace(/([\u3400-\u9fff])([A-Za-z0-9])/g, "$1 $2")
    .replace(/([A-Za-z0-9.])([\u3400-\u9fff])/g, "$1 $2")
    // A catalog's "关闭 {title}" reads "关闭 项目" around a Chinese title.
    .replace(/([\u3400-\u9fff]) ([\u3400-\u9fff])/g, "$1$2");
}
