import { CheckCircle2, CircleX } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { EmptyState } from "../components/ui/empty-state";
import { Button } from "../components/ui/button";
import { ReloadIconButton } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup } from "../components/ui/settings-row";
import type { DoctorReport } from "../app-types";

export function DoctorSettings(props: {
  doctorReport: DoctorReport | null;
  doctorBusy: boolean;
  doctorNotice: string;
  onRunDoctor: () => void;
  onOpenTexSetup: () => void;
}) {
  const { t } = useLingui();
  const report = props.doctorReport;
  const installAction = (
    <div className="settings-api-actions">
      <Button disabled={props.doctorBusy} onClick={props.onOpenTexSetup}>
        {t`Install required tools`}
      </Button>
    </div>
  );
  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title={t`TeX doctor`}
        description={t`Checks the tools Lattice needs to compile LaTeX`}
        actions={(
          <ReloadIconButton
            label={t`Run TeX doctor`}
            busy={props.doctorBusy}
            disabled={props.doctorBusy}
            onClick={props.onRunDoctor}
          />
        )}
      />
      <SettingsGroup title={t`Toolchain status`}>
        {report && (
          <>
            <div className={`doctor-status ${report.ok ? "ok" : "bad"}`}>
              {report.ok ? t`Ready to compile` : t`Missing required tools`}
            </div>
            <ul className="doctor-checklist">
              {report.checks.map((check) => (
                <li key={check.name} className={check.ok ? "ok" : "bad"}>
                  {check.ok ? <CheckCircle2 aria-hidden="true" /> : <CircleX aria-hidden="true" />}
                  <strong>{check.name}</strong>
                  <span className="doctor-check-result">
                    {check.ok ? t`Ready to compile` : t`Unavailable`}
                  </span>
                  {!check.ok && <span className="doctor-check-detail">{check.detail}</span>}
                </li>
              ))}
            </ul>
            {!report.ok && installAction}
          </>
        )}
        {!report && !props.doctorBusy && (
          <>
            <EmptyState
              align="start"
              density="compact"
              description={t`Run the doctor to inspect this Mac’s TeX toolchain`}
            />
            {installAction}
          </>
        )}
        {props.doctorNotice && <InlineMessage level="error" className="settings-inline">{props.doctorNotice}</InlineMessage>}
      </SettingsGroup>
    </div>
  );
}
