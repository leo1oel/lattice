import { useLingui } from "@lingui/react/macro";
import { useStore } from "zustand";
import { InfinityLoader } from "../components/ui/activity-icons";
import { useLoadingReveal } from "../components/ui/loading-reveal";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import type { OpenDocumentsStore } from "./open-documents-store";

/**
 * Over the editor while a file opens. It holds the pointer from the start
 * (a click meant for the old file must not land on it) but shows only once
 * the opening outlasts a glance, so switching to a file that reads at once
 * does not flash a scrim and a spinner over the page. The spinner stands
 * alone; the file's name goes to assistive technology (the tab names it).
 */
export function OpeningOverlay({ documents }: { documents: OpenDocumentsStore }) {
  // Subscribed here, so showing and hiding the overlay renders only it.
  const name = useStore(documents, (state) => state.opening?.label);
  return name ? <OpeningScrim name={name} /> : null;
}

function OpeningScrim({ name }: { name: string }) {
  const { t } = useLingui();
  const reveal = useLoadingReveal("opening");
  return (
    <div className="primary-opening-overlay loading-reveal" style={reveal}>
      <InfinityLoader size={16} />
      <LoadingAnnouncement message={t`Opening ${name}…`} />
    </div>
  );
}
