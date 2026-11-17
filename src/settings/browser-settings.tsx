import { useLingui } from "@lingui/react/macro";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup } from "../components/ui/settings-row";
import { linkDestination } from "../browser/link-destination";
import { useSharedSetting } from "./shared-setting";
import { SelectRow } from "./settings-controls";

export function BrowserSettings() {
  const { t } = useLingui();
  const [destination, setDestination] = useSharedSetting(linkDestination);
  return (
    <>
      <SettingsSectionHeader title={t`Browser`} />
      <SettingsGroup>
        <SelectRow data-setting="link-destination" label={t`Open links in`} value={destination} onChange={(chosen) => {
          setDestination(chosen === "panel" ? "panel" : "external");
        }} options={{ external: t`Default browser`, panel: t`Lattice panel` }} />
      </SettingsGroup>
    </>
  );
}
