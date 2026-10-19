import { useLingui } from "@lingui/react/macro";
import { InfinityLoader } from "../components/ui/activity-icons";
import { useLoadingReveal } from "../components/ui/loading-reveal";

/**
 * Over the editor while a file opens. It holds the pointer from the start
 * (a click meant for the old file must not land on it) but shows only once
 * the opening outlasts a glance, so switching to a file that reads at once
 * does not flash a scrim and a spinner over the page.
 */
export function OpeningOverlay({ name }: { name: string }) {
  const { t } = useLingui();
  const reveal = useLoadingReveal("opening");
  return (
    <div className="primary-opening-overlay loading-reveal" style={reveal} role="status" aria-live="polite">
      <InfinityLoader size={16} />
      <span>{t`Opening ${name}…`}</span>
    </div>
  );
}
