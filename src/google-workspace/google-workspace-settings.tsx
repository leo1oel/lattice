import { useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { GoogleWorkspaceAdvanced } from "./google-workspace-advanced";
import { openWorkspaceWebsite } from "./workspace-web";
import { PRODUCTS, PRODUCT_NAMES } from "./workspace-types";
import "./google-workspace.css";

export function GoogleWorkspaceSettings() {
  const { t } = useLingui();
  const [advanced, toggleAdvanced] = useReducer((value: boolean) => !value, false);
  const [failed, setFailed] = useReducer(
    (_: boolean, value: boolean) => value,
    false,
  );
  return (
    <div className="settings-section google-workspace-settings">
      <SettingsSectionHeader
        title={t`Google Workspace`}
        description={t`Open Docs, Sheets, Slides, Forms and Calendar on Google’s website. Use your browser’s existing Google account or sign in there. No client ID or Google Cloud setup is needed.`}
      />
      <div className="google-web-products">
        {PRODUCTS.map((product) => (
          <div className="google-web-product" key={product}>
            <strong>{PRODUCT_NAMES[product]}</strong>
            <div className="google-actions">
              <Button
                onClick={() => {
                  setFailed(false);
                  void openWorkspaceWebsite(product, false).catch(() =>
                    setFailed(true),
                  );
                }}
              >{t`Open in default browser`}</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setFailed(false);
                  void openWorkspaceWebsite(product, true).catch(() =>
                    setFailed(true),
                  );
                }}
              >{t`Open in Lattice`}</Button>
            </div>
          </div>
        ))}
      </div>
      <p className="google-setup-note">{t`Open in Lattice uses the built-in browser when available, with the system browser as a fallback. Google may require sign-in in your default browser; browser accounts and API authorization are separate.`}</p>
      {failed && (
        <InlineMessage level="error">{t`Could not open the Google website. Try again with your default browser.`}</InlineMessage>
      )}
      <Button
        variant="ghost"
        aria-expanded={advanced}
        aria-controls="google-workspace-advanced"
        onClick={toggleAdvanced}
      >{t`Advanced: Google API access`}</Button>
      {advanced && (
        <div id="google-workspace-advanced"><GoogleWorkspaceAdvanced /></div>
      )}
    </div>
  );
}
