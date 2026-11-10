import { Moon } from "lucide-react";
import type { MouseEvent } from "react";
import { Tip } from "../components/icon-tip";
import { useSharedSetting } from "../settings/shared-setting";
import { pdfDarkPagesSetting, togglePdfDarkPages } from "./pdf-dark-pages";

/**
 * The toolbar's Dark pages toggle: the one part of the viewer that re-renders
 * when the choice changes (the pages follow the root attribute, pdf-dark-pages.ts).
 */
export function PdfDarkPagesButton({ label }: { label: string }) {
  const [dark] = useSharedSetting(pdfDarkPagesSetting);
  return (
    <Tip label={label}>
      <button
        type="button"
        className={`pdf-overflow${dark ? " active" : ""}`}
        aria-pressed={dark}
        // Like the other toolbar toggles, it leaves focus where the reader had it.
        onMouseDown={(event: MouseEvent) => event.preventDefault()}
        onClick={togglePdfDarkPages}
      >
        <Moon size={14} />
      </button>
    </Tip>
  );
}
