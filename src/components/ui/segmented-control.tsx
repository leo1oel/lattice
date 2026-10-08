import { SlidingTabs, type SlidingTab } from "./motion";
import "./chrome.css";

export type SegmentedControlItem<Value extends string> = SlidingTab & { value: Value };

export function SegmentedControl<Value extends string>({
  value,
  onChange,
  items,
  ariaLabel,
  size = "compact",
  className,
  tabClassName,
}: {
  value: Value;
  onChange: (value: Value) => void;
  items: SegmentedControlItem<Value>[];
  ariaLabel: string;
  size?: "compact" | "default";
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
        className,
      ].filter(Boolean).join(" ")}
      tabClassName={["ui-segmented-tab", tabClassName].filter(Boolean).join(" ")}
    />
  );
}
