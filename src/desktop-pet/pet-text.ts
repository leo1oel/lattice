/* eslint-disable lingui/no-unlocalized-strings -- this independent native widget must not import the workspace's startup chunk; all widget copy is translated here for both supported locales */
const english = {
  drag: "Drag companion", hide: "Hide companion", wave: "wave",
  unavailable: "Companion unavailable", building: "Building", working: "Agent working", ready: "Ready",
};
const chinese: typeof english = {
  drag: "拖动桌面宠物", hide: "隐藏桌面宠物", wave: "挥手",
  unavailable: "桌面宠物暂不可用", building: "正在编译", working: "助手正在工作", ready: "就绪",
};
export function petText(locale: string): typeof english { return locale.startsWith("zh") ? chinese : english; }
