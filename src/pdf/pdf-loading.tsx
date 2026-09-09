import { useLingui } from "@lingui/react/macro";
import { InfinityLoader } from "../components/ui/activity-icons";
import "./pdf-viewer.css";

export function PdfLoading({ label, percent = null, quiet = false }: {
  label: string;
  percent?: number | null;
  quiet?: boolean;
}) {
  const { t } = useLingui();
  return (
    <div className={`pdf-loading smooth-shadow-ring-md${quiet ? " pdf-loading-quiet" : ""}`} role="status" aria-live="polite">
      <InfinityLoader size={quiet ? 14 : 17} />
      <span>{label}</span>
      {percent !== null && <>
        <div className="pdf-load-progress" role="progressbar" aria-label={t`PDF loading progress`}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="pdf-load-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="pdf-load-percent" aria-hidden="true">{percent}%</span>
      </>}
    </div>
  );
}
