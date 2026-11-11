import { useLingui } from "@lingui/react/macro";
import { Check, ChevronDown, LayoutDashboard } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useTrellisUi, type TrellisController } from "./trellis-controller";
import type { LayoutPreset } from "./trellis-layout";

/** A discoverable entry to the existing layout machinery, at the workspace's
 * foot rather than another permanent set of tabs in the title bar. */
export function WorkflowLayoutSwitch({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  const preset = useTrellisUi(controller, state => state.preset);
  const focus = useTrellisUi(controller, state => state.focus);
  const labels = { writing: t`Writing`, reading: t`Research`, bibliography: t`Bibliography` };
  const current = focus ? t`Focus mode` : preset ? labels[preset] : t`Custom layout`;
  return (
    <div className="workflow-layout-bar">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="workflow-layout-trigger" aria-label={t`Choose layout`}>
            <LayoutDashboard size={14} aria-hidden="true" />
            <span>{t`Layout`}: {current}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          {(["reading", "writing", "bibliography"] as const).map((mode: LayoutPreset) => (
            <DropdownMenuItem key={mode} role="menuitemradio" aria-checked={!focus && preset === mode} onSelect={() => controller.setPreset(mode)}>
              <span className="flex-1">{labels[mode]}</span>
              {!focus && preset === mode && <Check size={14} aria-hidden="true" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem role="menuitemradio" aria-checked={focus} onSelect={() => controller.setFocus(true)}>{t`Focus mode`}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem role="menuitemradio" aria-checked={!preset && !focus} onSelect={() => controller.setPreset(null)}>{t`Custom layout`}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
