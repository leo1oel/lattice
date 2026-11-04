import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { TexInstallDialog } from "./tex-install-dialog";
import { isConferenceFontsMissing, missingPaperToolNames, missingTexToolNames, type DoctorReportLike } from "./tex-setup";

export default function ServerToolSetup(props: {
  report: DoctorReportLike | null;
  checking: boolean;
  onClose: () => void;
  onRecheck: () => Promise<DoctorReportLike | null>;
}) {
  const { t } = useLingui();
  const missing = [...missingTexToolNames(props.report), ...missingPaperToolNames(props.report)];
  return <TexInstallDialog label={t`Server tools`} title={t`Configure tools on the server`} closeDisabled={false} onClose={props.onClose} progress={null} error={null}>
    <p className="body-compact">{t`Install the missing tools in the server's service environment, then recheck. You can continue editing while compilation is unavailable.`}</p>
    {missing.length > 0 && <p className="body-compact">{t`Missing tools: ${missing.join(", ")}`}</p>}
    {isConferenceFontsMissing(props.report) && <p className="body-compact">{t`The server's TeX installation also needs the conference fonts.`}</p>}
    <div className="modal-actions">
      <Button variant="ghost" onClick={props.onClose}>{t`Continue editing`}</Button>
      <Button onClick={() => { void props.onRecheck(); }} disabled={props.checking}>{t`Recheck server tools`}</Button>
    </div>
  </TexInstallDialog>;
}
