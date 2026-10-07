import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/** The sections the command palette lists commands under, and the shortcut sheet its App keys. */
export type PaletteSection = "navigate" | "edit" | "build" | "view" | "layout" | "research" | "overleaf" | "project" | "appearance";

/** Each section's name, in the order an empty palette lists them. */
export const PALETTE_SECTIONS: Record<PaletteSection, { order: number; label: MessageDescriptor }> = {
  navigate: { order: 0, label: msg`Navigate` },
  edit: { order: 1, label: msg`Edit` },
  build: { order: 2, label: msg`Build` },
  view: { order: 3, label: msg`View` },
  layout: { order: 4, label: msg`Layout` },
  research: { order: 5, label: msg`Research` },
  overleaf: { order: 6, label: msg`Overleaf` },
  project: { order: 7, label: msg`Project` },
  appearance: { order: 8, label: msg`Appearance` },
};
