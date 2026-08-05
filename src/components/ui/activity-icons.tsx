import {
  useState,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { RefreshCw } from "lucide-react";
import infinityLoaderUrl from "../../../infinity-loader.svg";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "./button";
import { IconButton, type IconButtonProps } from "./icon-button";
import "./activity-icons.css";

export function InfinityLoader(props: {
  size?: number;
  className?: string;
  label?: string;
}) {
  const size = props.size ?? 16;
  return (
    <span
      className={cn("ui-infinity-loader", props.className)}
      style={{ width: size, height: size }}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    >
      <img src={infinityLoaderUrl} alt="" aria-hidden="true" />
    </span>
  );
}

function ReloadGlyph(props: {
  busy: boolean;
  turn: number;
  size: number;
}) {
  return (
    <span
      key={props.busy ? "busy" : props.turn}
      className={cn(
        "ui-reload-icon",
        props.busy && "spin",
        !props.busy && props.turn > 0 && "ui-reload-icon--once",
      )}
      aria-hidden="true"
    >
      <RefreshCw size={props.size} />
    </span>
  );
}

function useReloadClick(
  onClick: MouseEventHandler<HTMLButtonElement> | undefined,
) {
  const [turn, setTurn] = useState(0);
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    setTurn((value) => value + 1);
    onClick?.(event);
  };
  return { turn, handleClick };
}

export function ReloadButton({
  busy = false,
  children,
  className,
  iconSize = 14,
  onClick,
  ...props
}: ButtonProps & {
  busy?: boolean;
  children: ReactNode;
  iconSize?: number;
}) {
  const reload = useReloadClick(onClick);
  return (
    <Button
      {...props}
      className={cn("ui-reload-button", className)}
      onClick={reload.handleClick}
      aria-busy={busy || undefined}
    >
      <ReloadGlyph busy={busy} turn={reload.turn} size={iconSize} />
      {children}
    </Button>
  );
}

export function ReloadIconButton({
  busy = false,
  iconSize = 15,
  onClick,
  ...props
}: Omit<IconButtonProps, "children"> & {
  busy?: boolean;
  iconSize?: number;
}) {
  const reload = useReloadClick(onClick);
  return (
    <IconButton
      {...props}
      onClick={reload.handleClick}
      aria-busy={busy || undefined}
    >
      <ReloadGlyph busy={busy} turn={reload.turn} size={iconSize} />
    </IconButton>
  );
}
