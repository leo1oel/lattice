import { useLingui } from "@lingui/react/macro";
import { SwitchField } from "../components/ui/switch-field";
import { SettingsGroup } from "../components/ui/settings-row";
import type { TitlebarTool } from "./app-settings";
import type { SettingsDialogProps } from "./settings-dialog";

/** Which tool buttons sit at the right of the title bar; the commands stay in the palette either way. */
export function TitlebarToolsGroup(props: SettingsDialogProps) {
  const { t } = useLingui();
  const hidden = props.appearance.hiddenTitlebarTools;
  const tools: Array<{ tool: TitlebarTool; label: string }> = [
    { tool: "comments", label: t`Annotations` },
    { tool: "overleaf", label: t`Overleaf` },
    { tool: "git", label: t`Git status and commit` },
    { tool: "history", label: t`Project history` },
    { tool: "browser", label: t`Open in browser` },
  ];
  return (
    <SettingsGroup title={t`Title bar tools`} data-setting="titlebar-tools">
      {tools.map(({ tool, label }) => (
        <SwitchField
          key={tool}
          label={label}
          checked={!hidden.includes(tool)}
          onChange={(shown) => props.setAppearance({
            ...props.appearance,
            hiddenTitlebarTools: shown ? hidden.filter((item) => item !== tool) : [...hidden, tool],
          })}
        />
      ))}
    </SettingsGroup>
  );
}
