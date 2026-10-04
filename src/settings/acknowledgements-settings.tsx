import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { fontLicense } from "virtual:lattice-private-fonts-license";
import { Button } from "../components/ui/button";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import "./acknowledgements-settings.css";

/* eslint-disable lingui/no-unlocalized-strings -- names of works, their sites, and an attribution kept verbatim */
const TIMELESS = { name: "Timeless", site: "timeless.co", url: "https://timeless.co" };
// The attribution Trellis's license asks shipped apps to show, as the macOS
// About panel shows it (TRELLIS_ATTRIBUTION in src-tauri/src/native_locale.rs).
const TRELLIS = { name: "Trellis", site: "GitHub", url: "https://github.com/DanFessler/trellis", attribution: "Uses Trellis by DanFessler" };
/* eslint-enable lingui/no-unlocalized-strings */

function LinkButton({ url, label }: { url: string; label: string }) {
  return (
    <Button variant="ghost" size="compact" onClick={() => void openUrl(url)}>
      {label} <ExternalLink size={12} />
    </Button>
  );
}

function FontLicenseGroup({ license }: { license: NonNullable<typeof fontLicense> }) {
  const { t } = useLingui();
  const { title } = license;
  return (
    <SettingsGroup title={t`Interface fonts`}>
      <SettingsRow
        label={TIMELESS.name}
        description={t`Type family by Timeless Ventures Private Limited, Chennai, used under the ${title}. Get the fonts from timeless.co`}
      >
        <LinkButton url={TIMELESS.url} label={TIMELESS.site} />
      </SettingsRow>
      <section className="acknowledgements-license" aria-label={title}>
        {license.text.split("\n\n").map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </section>
    </SettingsGroup>
  );
}

/**
 * Settings › About › Acknowledgements: credit for the work Lattice ships that
 * asks for it. A build that embeds the Timeless fonts also shows their license,
 * read from the copy that came with the fonts (scripts/private-fonts.ts): the
 * license lets the fonts go to no one without it. Builds without the fonts
 * leave the entry out.
 */
export function AcknowledgementsSettings() {
  const { t } = useLingui();
  return (
    <div className="settings-section">
      <SettingsSectionHeader title={t`Acknowledgements`} />
      {fontLicense && <FontLicenseGroup license={fontLicense} />}
      <SettingsGroup title={t`Panel layout`}>
        <SettingsRow label={TRELLIS.name} description={TRELLIS.attribution}>
          <LinkButton url={TRELLIS.url} label={TRELLIS.site} />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
