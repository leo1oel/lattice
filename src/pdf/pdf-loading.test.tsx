import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, expect, it } from "vitest";
import { i18n } from "../i18n";
import { PdfLoading } from "./pdf-loading";

afterEach(cleanup);
const renderLoading = (props: Parameters<typeof PdfLoading>[0]) =>
  render(<I18nProvider i18n={i18n}><PdfLoading {...props} /></I18nProvider>);

it("shows a first load as the page skeleton alone, its stage said to assistive technology", async () => {
  const view = renderLoading({ phase: "rendering" });
  expect(view.container.querySelector(".pdf-skeleton")).not.toBeNull();
  expect(view.container.querySelector(".ui-infinity-loader, .pdf-loading")).toBeNull();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Rendering first page…"));
  expect(screen.getByRole("status")).toHaveClass("loading-announcement");
});

it("shapes the skeleton page for the fit or zoom the page opens at", () => {
  const height = renderLoading({ phase: "loading", view: { fitMode: "height", scale: 1 } });
  expect(height.container.querySelector(".pdf-skeleton")).toHaveAttribute("data-fit", "height");
  height.unmount();
  const zoom = renderLoading({ phase: "loading", view: { fitMode: null, scale: 1.5 } });
  const skeleton = zoom.container.querySelector<HTMLElement>(".pdf-skeleton")!;
  expect(skeleton).toHaveAttribute("data-fit", "zoom");
  expect(skeleton.style.getPropertyValue("--pdf-skeleton-width")).toBe("918px");
});

it("shows a refresh of a PDF already on screen as one small Updating status, no page over it", () => {
  const view = renderLoading({ phase: "loading", quiet: true });
  expect(view.container.querySelector(".pdf-skeleton")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Updating…");
  expect(view.container.querySelectorAll(".ui-infinity-loader")).toHaveLength(1);
});
