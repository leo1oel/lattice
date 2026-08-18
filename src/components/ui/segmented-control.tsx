import type { ReactNode } from "react";
import { SlidingTabs } from "./motion";
import "./chrome.css";

export type SegmentedControlItem<Value extends string> = {
  value: Value;
  label: ReactNode;
  title?: string;
  dataTour?: string;
};

export function SegmentedControl<Value extends string>({
  value,
  onChange,
  items,
  ariaLabel,
  size = "compact",
  tone = "neutral",
  className,
  tabClassName,
}: {
  value: Value;
  onChange: (value: Value) => void;
  items: SegmentedControlItem<Value>[];
  ariaLabel: string;
  size?: "compact" | "default";
  tone?: "neutral" | "accent";
  className?: string;
  tabClassName?: string;
}) {
  return (
    <SlidingTabs
      value={value}
      onChange={(next) => onChange(next as Value)}
      items={items}
      ariaLabel={ariaLabel}
      className={[
        "ui-segmented",
        `ui-segmented--${size}`,
        `ui-segmented--${tone}`,
        className,
      ].filter(Boolean).join(" ")}
      tabClassName={["ui-segmented-tab", tabClassName].filter(Boolean).join(" ")}
    />
  );
}
