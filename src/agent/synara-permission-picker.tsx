import { useId, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { Hand, Shield, ShieldCheck } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { RadioGroup, RadioItem } from "../components/ui/radio-group";
import type { SynaraPermissionMode } from "../app/app-synara-embed";

function SynaraPermissionIcon({ mode }: { mode: SynaraPermissionMode }) {
  if (mode === "full-access") return <ShieldCheck size={14} />;
  if (mode === "auto") return <Shield size={14} />;
  return <Hand size={14} />;
}

export default function SynaraPermissionPicker(props: {
  value: SynaraPermissionMode;
  autoModeAvailable: boolean;
  onChange: (value: SynaraPermissionMode) => void;
}) {
  const { t } = useLingui();
  const descriptionId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const modes = ["full-access", "auto", "approval-required"] as const;
  const presentations: Record<SynaraPermissionMode, { label: string; description: string }> = {
    "full-access": {
      label: t`Full access`,
      description: t`Run without asking for approval`,
    },
    auto: {
      label: t`Approve for me`,
      description: t`Ask only for potentially unsafe actions`,
    },
    "approval-required": {
      label: t`Ask for approval`,
      description: t`Ask before external edits and network access`,
    },
  };
  const { label } = presentations[props.value];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="agent-permission-trigger"
          aria-label={t`Agent permissions: ${label}`}
          title={t`Agent permissions: ${label}`}
        >
          <SynaraPermissionIcon mode={props.value} />
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
                  selected={props.value === mode}
                  onSelect={() => { if (!disabled) props.onChange(mode); }}
                  aria-disabled={disabled || undefined}
                  aria-describedby={`${descriptionId}-${mode}`}
                  // Exclude unavailable modes from the library's arrow-key targets.
                  data-fluid-hover-index={disabled ? undefined : index}
                  tabIndex={!disabled && props.value === mode ? 0 : -1}
                  className="agent-permission-radio"
                />
                <small id={`${descriptionId}-${mode}`} className="agent-permission-description">{option.description}</small>
              </div>
            );
          })}
        </RadioGroup>
      </PopoverContent>
    </Popover>
  );
}
