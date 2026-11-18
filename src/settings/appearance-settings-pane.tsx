import { useLingui } from "@lingui/react/macro";
import { SegmentedControl } from "../components/ui/segmented-control";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import type { AppearanceSettings, TitlebarTool } from "./app-settings";
import { CodeThemeSettingsGroup } from "./code-theme-settings";
import { EditorFontSettingsGroups } from "./editor-font-settings";
import { INTERFACE_SCALE_STEPS, interfaceScalePercent, nearestInterfaceStep } from "./interface-scale";
import { SelectRow } from "./settings-controls";
import type { SettingsDialogProps } from "./settings-dialog";
import { ThemeSettingsGroup } from "./theme-settings";

function patchAppearance(props: SettingsDialogProps, patch: Partial<AppearanceSettings>) {
  props.setAppearance({ ...props.appearance, ...patch });
}

/** Which tool buttons sit at the right of the title bar; the commands stay in the palette either way. */
function TitlebarToolsGroup(props: SettingsDialogProps) {
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
          onChange={(shown) => patchAppearance(props, {
            hiddenTitlebarTools: shown ? hidden.filter((item) => item !== tool) : [...hidden, tool],
          })}
        />
      ))}
    </SettingsGroup>
  );
}

export function AppearanceSettingsPane(props: SettingsDialogProps) {
  const { t } = useLingui();

  return (
    <div className="settings-section">
      <SettingsSectionHeader title={t`Appearance`} />
      {/* The page title already names these; a "General" heading under it
          would only repeat the sidebar. */}
      <SettingsGroup>
        <SelectRow
          data-setting="interface-language"
          label={t`Interface language`}
          value={props.appearance.interfaceLanguage}
          options={{ system: t`Match system`, en: t`English`, "zh-CN": t`Simplified Chinese` }}
          onChange={(interfaceLanguage) => patchAppearance(props, { interfaceLanguage })}
        />
        <SettingsRow data-setting="interface-size" label={t`Interface size`}>
          <SegmentedControl
            ariaLabel={t`Interface size`}
            className="interface-size-control"
            value={String(nearestInterfaceStep(props.appearance.interfaceScale))}
            onChange={(value) => patchAppearance(props, { interfaceScale: Number(value) })}
            items={INTERFACE_SCALE_STEPS.map((step) => ({ value: String(step), label: interfaceScalePercent(step) }))}
          />
        </SettingsRow>
        <SwitchField
          data-setting="interface-sounds"
          label={t`Interface sounds`}
          checked={props.appearance.interfaceSounds}
          onChange={(interfaceSounds) => patchAppearance(props, { interfaceSounds })}
        />
        <SelectRow
          data-setting="toast-position"
          label={t`Notification position`}
          value={props.appearance.toastPosition}
          options={{
            "top-right": t`Top right`,
            "top-center": t`Top center`,
            "bottom-right": t`Bottom right`,
            "bottom-center": t`Bottom center`,
          }}
          onChange={(toastPosition) => patchAppearance(props, { toastPosition })}
        />
      </SettingsGroup>
      <EditorFontSettingsGroups appearance={props.appearance} setAppearance={props.setAppearance} />
      <ThemeSettingsGroup {...props} />
      <CodeThemeSettingsGroup {...props} />
      <TitlebarToolsGroup {...props} />
    </div>
  );
}
