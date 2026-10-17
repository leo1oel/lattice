import { lazy } from "react";

export const SettingsDialogSurface = lazy(() =>
  import("./settings-dialog").then((module) => ({ default: module.SettingsDialog })),
);
