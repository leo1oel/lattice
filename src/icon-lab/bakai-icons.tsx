import type { CSSProperties, ComponentType } from "react";
import { FadersLive } from "./bakai/faders";
import { UsersThreeLive } from "./bakai/users-three";
import { ListChecksLive } from "./bakai/list-checks";
import { KanbanLive } from "./bakai/kanban";
import { FolderLive } from "./bakai/folder";
import { GearLive } from "./bakai/gear";
import { ChatLive } from "./bakai/chat";
import { TrashLive } from "./bakai/trash";
import { CloudArrowUpLive } from "./bakai/cloud-upload";
import { KeyLive } from "./bakai/api-key";
import { GitBranchLive } from "./bakai/git-branch";
import { PlugsLive } from "./bakai/plugs";
import { ClipboardTextLive } from "./bakai/logs";
import { RobotLive } from "./bakai/robot";
import { SparkleLive } from "./bakai/sparkle";
import "./bakai-icons.css";

/** Exact components copied from the author-provided bakai.me icon-code.json. */
export type BakaiIconKind = "faders" | "users" | "list-checks" | "kanban" | "folder" | "gear" | "chat" | "trash" | "cloud-upload" | "api-key" | "git-branch" | "plugs" | "logs" | "robot" | "sparkle";

type VendorIcon = ComponentType<{ size?: number; className?: string }>;

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
};

export function BakaiAnimatedIcon({ kind, size = 20, playing, reducedMotion, speed = "normal", className }: { kind: BakaiIconKind; size?: number; playing?: boolean; reducedMotion?: boolean; speed?: "normal" | "slow"; playId?: number; className?: string }) {
  const { Icon, sourceClass } = icons[kind];
  const classes = ["bakai-icon", playing && "is-playing", reducedMotion && "is-reduced", className].filter(Boolean).join(" ");
  const style = { "--bk-speed": speed === "slow" ? 1.9 : 1 } as CSSProperties;

  return <span className={classes} style={style}><Icon size={size} className={sourceClass} /></span>;
}
