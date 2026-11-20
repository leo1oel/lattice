import { createContext } from "react";
import type { LivePreviewSession } from "./live-preview-session";

/**
 * What the live preview's layer draws from: the running session in the
 * workspace window, or its mirror in the PDF's separate window
 * (live-preview-mirror.ts).
 */
export type LivePreviewSurface = Pick<
  LivePreviewSession, "model" | "fonts" | "images" | "basePromoted" | "subscribePages" | "fallbackDocument" | "waitForLayout" | "painted"
>;

/** The live preview the layer PdfPreview renders on its pages draws. */
export const LivePreviewSessionContext = createContext<LivePreviewSurface | null>(null);
