/** The experimental Windows host's LaTeX setup dialog; see windows-host-ui.ts. */
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TexInstallDialog } from "../build/tex-install-dialog";
import { Button } from "../components/ui/button";

/**
 * The setup dialog for a missing TeX or paper-tool install. There is no
 * one-click installer on Windows, so it links to TeX Live and lets the
 * writer keep editing.
 */
export function WindowsTexSetupDialog(props: {
  paperToolsOnly: boolean;
  checking: boolean;
  onClose: () => void;
  onRecheck: () => unknown;
}) {
  const { t } = useLingui();
  const { paperToolsOnly } = props;
  return (
    <TexInstallDialog
      label={t`Install LaTeX tools`}
      title={paperToolsOnly ? t`Install required paper tools` : t`Install LaTeX to compile`}
      description={paperToolsOnly
        ? t`Automatic paper-tool installation isn’t available in this experimental Windows build.`
        : t`Install TeX Live for Windows, then check again. You can keep editing without LaTeX.`}
      closeDisabled={false}
      onClose={props.onClose}
      progress={null}
      error={null}
    >
      <div className="modal-actions">
        <Button variant="ghost" onClick={props.onClose}>{t`Install later`}</Button>
        <Button disabled={props.checking} onClick={() => void props.onRecheck()}>{t`Check again`}</Button>
        {!paperToolsOnly && <Button variant="primary" onClick={() => void openUrl("https://tug.org/texlive/windows.html")}>{t`Download TeX Live`}</Button>}
      </div>
    </TexInstallDialog>
  );
}
