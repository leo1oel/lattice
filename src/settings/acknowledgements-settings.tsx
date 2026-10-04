import { Suspense, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, FileText } from "lucide-react";
import { fontLicenseUrl } from "virtual:lattice-private-fonts-license";
import { Button } from "../components/ui/button";
import { PanelHeader } from "../components/ui/panel-header";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { PdfPreview, PdfPreviewLoading } from "../canvas/canvas-lazy-editors";
import "./acknowledgements-settings.css";

/* eslint-disable lingui/no-unlocalized-strings -- the names of a work, its license and its site, kept verbatim */
const TIMELESS = { name: "Timeless", license: "Timeless Free Font License", site: "timeless.co", url: "https://timeless.co" };
/* eslint-enable lingui/no-unlocalized-strings */

/** The license exactly as it came with the fonts, in the app's own PDF viewer. */
function FontLicenseDialog({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <SheetDialog className="acknowledgements-license" label={TIMELESS.license} onClose={onClose}>
      <PanelHeader className="drawer-header" icon={<FileText size={16} />} title={TIMELESS.license} onClose={onClose} />
      <div className="acknowledgements-license-viewer">
        <Suspense fallback={<PdfPreviewLoading />}>
          <PdfPreview url={url} showSave={false} />
        </Suspense>
      </div>
    </SheetDialog>
  );
}

/**
 * Settings › About › Acknowledgements, in builds that embed the Timeless fonts
 * (scripts/private-fonts.ts): their credit and the license that came with them,
 * shipped unmodified, since the license lets the fonts go to no one without it.
 */
export function AcknowledgementsSettings() {
  const { t } = useLingui();
  const [licenseOpen, setLicenseOpen] = useState(false);
  if (!fontLicenseUrl) return null;
  const license = TIMELESS.license;
  return (
    <div className="settings-section">
      <SettingsSectionHeader title={t`Acknowledgements`} />
      <SettingsGroup title={t`Interface fonts`}>
        <SettingsRow
          label={TIMELESS.name}
          description={t`Type family by Timeless Ventures Private Limited, Chennai, used under the ${license}. Get the fonts from timeless.co`}
        >
          <Button variant="ghost" size="compact" onClick={() => setLicenseOpen(true)}>
            {t`View license`}
          </Button>
          <Button variant="ghost" size="compact" onClick={() => void openUrl(TIMELESS.url)}>
            {TIMELESS.site} <ExternalLink size={12} />
          </Button>
        </SettingsRow>
      </SettingsGroup>
      {licenseOpen && <FontLicenseDialog url={fontLicenseUrl} onClose={() => setLicenseOpen(false)} />}
    </div>
  );
}
