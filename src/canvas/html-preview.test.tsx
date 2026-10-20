import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HtmlPreview } from "./html-preview";

afterEach(cleanup);

describe("the HTML preview", () => {
  // A srcdoc frame is blank until its page loads; showing it then would put
  // a blank page, then the page, on screen.
  it("keeps its frame hidden behind the page skeleton until the page has loaded once", () => {
    const { container } = render(<HtmlPreview path="site/index.html" source="<h1>Hello</h1>" />);
    const frame = container.querySelector<HTMLIFrameElement>(".html-preview-frame")!;
    expect(frame.style.visibility).toBe("hidden");
    expect(container.querySelector(".document-skeleton")?.getAttribute("data-shape")).toBe("page");
    fireEvent.load(frame);
    expect(frame.style.visibility).toBe("");
    expect(container.querySelector(".document-skeleton")).toBeNull();
  });
});
