import { useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { Hand, Shield, ShieldCheck } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { RadioGroup, RadioItem } from "../components/ui/radio-group";
import type { SynaraPermissionMode } from "../app/app-synara-embed";

const MODE_ICONS = { "full-access": ShieldCheck, auto: Shield, "approval-required": Hand } as const;

export default function SynaraPermissionPicker(props: {
  value: SynaraPermissionMode;
  autoModeAvailable: boolean;
  onChange: (value: SynaraPermissionMode) => void;
}) {
  const { t } = useLingui();
  const groupRef = useRef<HTMLDivElement>(null);
  const modes = ["full-access", "auto", "approval-required"] as const;
  // Each label says the behaviour, so no option needs a description line.
  const presentations: Record<SynaraPermissionMode, { label: string }> = {
    "full-access": { label: t`Never ask` },
    auto: { label: t`Ask for risky actions` },
    "approval-required": { label: t`Ask before edits and network` },
  };
  const { label } = presentations[props.value];
  const ModeIcon = MODE_ICONS[props.value];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="agent-permission-trigger"
          aria-label={t`Agent permissions: ${label}`}
          title={t`Agent permissions: ${label}`}
        >
          <ModeIcon size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="agent-permission-menu"
        aria-label={t`Agent permissions: ${label}`}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          groupRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
        }}
      >
        <RadioGroup ref={groupRef} selectedIndex={modes.indexOf(props.value)} className="w-full" aria-label={t`Agent permissions: ${label}`}>
          {modes.map((mode, index) => {
            const option = presentations[mode];
            const disabled = mode === "auto" && !props.autoModeAvailable;
            return (
              <div key={mode} className="agent-permission-option" data-disabled={disabled || undefined}>
                <RadioItem
                  index={index}
                  label={option.label}
                  onSelect={() => { if (!disabled) props.onChange(mode); }}
                  aria-disabled={disabled || undefined}
                  // Exclude unavailable modes from the library's arrow-key targets.
                  data-fluid-hover-index={disabled ? undefined : index}
                  tabIndex={!disabled && props.value === mode ? 0 : -1}
                  className="agent-permission-radio"
                />
              </div>
            );
          })}
        </RadioGroup>
      </PopoverContent>
    </Popover>
  );
}
