// Open Slide's copy that names its own agent or dev server, reworded for the
// Lattice AI panel and the runtime Lattice supervises.
import { moduleFilePath, replaceRequired } from "./patch-contract.mjs";

export function transformOpenSlideConnectionCopy(source, id) {
  const modulePath = moduleFilePath(id);
  const replacements = modulePath.endsWith("/@open-slide/core/src/locale/en.ts")
    ? [
        ["agentDisconnected: 'Agent disconnected'", "agentDisconnected: 'Live context disconnected'"],
        [
          "'Lost connection to the dev server, so your agent can no longer see the current slide or inspector selection. Restart the dev server to restore the connection.'",
          "'The current slide and inspector selection are not syncing. The agent can still edit deck files. Reopen the presentation to restore live context.'",
        ],
        [
          "noThemesHintPrefix: 'Run '",
          "noThemesHintPrefix: 'Ask Lattice AI to create one, or enter '",
        ],
        [
          "noThemesHintSuffix: ' to author one — a markdown file under themes/ plus a sibling demo slide.'",
          "noThemesHintSuffix: ' in the AI composer and choose Create Theme from the slash menu.'",
        ],
        [
          "noDemoHintPrefix: 'Re-run '",
          "noDemoHintPrefix: 'Ask Lattice AI to regenerate it, or enter '",
        ],
        [
          "noDemoHintSuffix: ' for this theme to generate a preview slide.'",
          "noDemoHintSuffix: ' in the AI composer and choose Create Theme from the slash menu.'",
        ],
        ["openTitle: 'Open the agent panel'", "openTitle: 'Ask Lattice AI'"],
      ]
    : modulePath.endsWith("/@open-slide/core/src/locale/zh-cn.ts")
      ? [
          ["agentDisconnected: 'Agent 已断开'", "agentDisconnected: '页面上下文未同步'"],
          [
            "'已和 dev server 断开连接，agent 没办法再看到你目前的 slide 或 Inspector 选择。请重新启动 dev server 来恢复连接。'",
            "'当前页面与检查器选区未同步。Agent 仍可编辑演示文稿文件；请重新打开演示文稿以恢复实时上下文。'",
          ],
          [
            "noThemesHintPrefix: '运行 '",
            "noThemesHintPrefix: '让 Lattice AI 为你创建主题，或在 AI 输入框中输入 '",
          ],
          [
            "noThemesHintSuffix: ' 来创建一个 — 一个位于 themes/ 的 markdown 文件，加上同名的 demo slide。'",
            "noThemesHintSuffix: '，并从斜杠菜单中选择“创建主题”。'",
          ],
          [
            "noDemoHintPrefix: '对此主题重新运行 '",
            "noDemoHintPrefix: '让 Lattice AI 重新生成预览，或在 AI 输入框中输入 '",
          ],
          [
            "noDemoHintSuffix: ' 即可生成预览用的 slide。'",
            "noDemoHintSuffix: '，并从斜杠菜单中选择“创建主题”。'",
          ],
          ["openTitle: '打开 agent 面板'", "openTitle: '询问 Lattice AI'"],
        ]
      : null;
  if (!replacements) return null;
  let transformed = source;
  for (const [before, after] of replacements) {
    transformed = replaceRequired(transformed, before, after, "locale copy");
  }
  return transformed;
}
