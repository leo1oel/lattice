import type { CSSProperties, ComponentType } from "react";
import { FadersLive } from "../icon-lab/bakai/faders";
import { UsersThreeLive } from "../icon-lab/bakai/users-three";
import { ListChecksLive } from "../icon-lab/bakai/list-checks";
import { KanbanLive } from "../icon-lab/bakai/kanban";
import { FolderLive } from "../icon-lab/bakai/folder";
import { GearLive } from "../icon-lab/bakai/gear";
import { ChatLive } from "../icon-lab/bakai/chat";
import { TrashLive } from "../icon-lab/bakai/trash";
import { CloudArrowUpLive } from "../icon-lab/bakai/cloud-upload";
import { KeyLive } from "../icon-lab/bakai/api-key";
import { GitBranchLive } from "../icon-lab/bakai/git-branch";
import { PlugsLive } from "../icon-lab/bakai/plugs";
import { ClipboardTextLive } from "../icon-lab/bakai/logs";
import { RobotLive } from "../icon-lab/bakai/robot";
import { SparkleLive } from "../icon-lab/bakai/sparkle";
import { ClockBackLive } from "../icon-lab/bakai/clock-back";
import "../icon-lab/bakai-icons.css";

/** Exact components copied from the author-provided bakai.me icon-code.json. */
export type BakaiIconKind = "faders" | "users" | "list-checks" | "kanban" | "folder" | "gear" | "chat" | "trash" | "cloud-upload" | "api-key" | "git-branch" | "plugs" | "logs" | "robot" | "sparkle" | "clock-back";

type VendorIcon = ComponentType<{ size?: number; className?: string; converted?: boolean }>;

const icons: Record<BakaiIconKind, { Icon: VendorIcon; sourceClass: string }> = {
  faders: { Icon: FadersLive, sourceClass: "lg-faders" },
  users: { Icon: UsersThreeLive, sourceClass: "lg-u3" },
  "list-checks": { Icon: ListChecksLive, sourceClass: "lg-checks" },
  kanban: { Icon: KanbanLive, sourceClass: "lg-kanban" },
  folder: { Icon: FolderLive, sourceClass: "lg-folder" },
  gear: { Icon: GearLive, sourceClass: "lg-gear" },
  chat: { Icon: ChatLive, sourceClass: "lg-chat" },
  trash: { Icon: TrashLive, sourceClass: "lg-trash" },
  "cloud-upload": { Icon: CloudArrowUpLive, sourceClass: "lg-cloudup" },
  "api-key": { Icon: KeyLive, sourceClass: "lg-toss" },
  "git-branch": { Icon: GitBranchLive, sourceClass: "lg-branch" },
  plugs: { Icon: PlugsLive, sourceClass: "lg-plug" },
  logs: { Icon: ClipboardTextLive, sourceClass: "lg-tail" },
  robot: { Icon: RobotLive, sourceClass: "lg-robot" },
  sparkle: { Icon: SparkleLive, sourceClass: "lg-bloom" },
  "clock-back": { Icon: ClockBackLive, sourceClass: "lg-clockback" },
};

export function BakaiAnimatedIcon({ kind, size = 20, playing, reducedMotion, speed = "normal", converted, className }: { kind: BakaiIconKind; size?: number; playing?: boolean; reducedMotion?: boolean; speed?: "normal" | "slow"; playId?: number; converted?: boolean; className?: string }) {
  const { Icon, sourceClass } = icons[kind];
  const classes = ["bakai-icon", playing && "is-playing", reducedMotion && "is-reduced", className].filter(Boolean).join(" ");
  const style = { "--bk-speed": speed === "slow" ? 1.9 : 1 } as CSSProperties;

  return <span className={classes} style={style}><Icon size={size} className={sourceClass} converted={converted} /></span>;
}
