import type { CSSProperties, ComponentType } from "react";
import { FadersLive } from "./bakai/faders";
import { ChatLive } from "./bakai/chat";
import { CloudArrowUpLive } from "./bakai/cloud-upload";
import { KeyLive } from "./bakai/api-key";
import { GitBranchLive } from "./bakai/git-branch";
import { PlugsLive } from "./bakai/plugs";
import { ClipboardTextLive } from "./bakai/logs";
import { RobotLive } from "./bakai/robot";
import { SparkleLive } from "./bakai/sparkle";
import { ClockBackLive } from "./bakai/clock-back";
import { ReceiptLive } from "./bakai/receipt";
import { PackageLive } from "./bakai/package";
import "./bakai-icons.css";

/**
 * Components copied from the author-provided bakai.me icon-code.json.
 *
 * Phosphor ships each icon as ONE compound path, so nothing inside it can be
 * animated independently. Each glyph is rebuilt from Phosphor's own fill
 * geometry (same 256 viewBox, same coordinates) split into the pieces its
 * gesture needs; at rest it is meant to be indistinguishable from the original.
 * Where a gesture only ADDS something, the source glyph is left untouched and
 * the new element is drawn beside it.
 */
export type BakaiIconKind = "faders" | "chat" | "cloud-upload" | "api-key" | "git-branch" | "plugs" | "logs" | "robot" | "sparkle" | "clock-back" | "receipt" | "package";

type VendorIcon = ComponentType<{ size?: number; className?: string; converted?: boolean }>;

const icons: Record<BakaiIconKind, { Icon: VendorIcon; sourceClass: string }> = {
  faders: { Icon: FadersLive, sourceClass: "lg-faders" },
  chat: { Icon: ChatLive, sourceClass: "lg-chat" },
  "cloud-upload": { Icon: CloudArrowUpLive, sourceClass: "lg-cloudup" },
  "api-key": { Icon: KeyLive, sourceClass: "lg-toss" },
  "git-branch": { Icon: GitBranchLive, sourceClass: "lg-branch" },
  plugs: { Icon: PlugsLive, sourceClass: "lg-plug" },
  logs: { Icon: ClipboardTextLive, sourceClass: "lg-tail" },
  robot: { Icon: RobotLive, sourceClass: "lg-robot" },
  sparkle: { Icon: SparkleLive, sourceClass: "lg-bloom" },
  "clock-back": { Icon: ClockBackLive, sourceClass: "lg-clockback" },
  receipt: { Icon: ReceiptLive, sourceClass: "lg-receipt" },
  package: { Icon: PackageLive, sourceClass: "lg-deliver" },
};

export function BakaiAnimatedIcon({ kind, size = 20, playing, reducedMotion, speed = "normal", converted, className }: { kind: BakaiIconKind; size?: number; playing?: boolean; reducedMotion?: boolean; speed?: "normal" | "slow"; converted?: boolean; className?: string }) {
  const { Icon, sourceClass } = icons[kind];
  const classes = ["bakai-icon", playing && "is-playing", reducedMotion && "is-reduced", className].filter(Boolean).join(" ");
  const style = { "--bk-speed": speed === "slow" ? 1.9 : 1 } as CSSProperties;

  return <span className={classes} style={style}><Icon size={size} className={sourceClass} converted={converted} /></span>;
}
