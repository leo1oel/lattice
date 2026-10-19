import { createContext } from "react";
import type { LivePreviewSession } from "./live-preview-session";

/** The running live preview session, for the layer PdfPreview renders on its pages. */
export const LivePreviewSessionContext = createContext<LivePreviewSession | null>(null);
