import type { Root } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { MotionConfig } from "motion/react";
import { TipProvider } from "../components/icon-tip";
import { i18n } from "../i18n";
import { RootErrorBoundary } from "../telemetry/root-error-boundary";
import { ToastStack } from "../telemetry/toast-stack";
import { PdfWindowPage } from "./pdf-window-page";

/** The window's page, under the providers App's tree has; the menu bar and the updater belong to the workspace windows. */
export function renderPdfWindow(root: Root) {
  root.render(
    <MotionConfig reducedMotion="user">
      <I18nProvider i18n={i18n}>
        <RootErrorBoundary>
          <TipProvider>
            <PdfWindowPage />
            <ToastStack />
          </TipProvider>
        </RootErrorBoundary>
      </I18nProvider>
    </MotionConfig>,
  );
}
