import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectFindDialog } from "./project-find-dialog";

describe("ProjectFindDialog", () => {
  it("lists hits and opens the selected file line", () => {
    const onOpenHit = vi.fn();
    const onSearch = vi.fn();
    render(
      <ProjectFindDialog
        open
        busy={false}
        error={null}
        hits={[
          {
            kind: "file",
            path: "sections/method.tex",
            title: "method.tex",
            snippet: "A distinctive latent alignment objective.",
            line: 2,
          },
        ]}
        onClose={() => undefined}
        onSearch={onSearch}
        onOpenHit={onOpenHit}
      />,
    );

    fireEvent.click(screen.getByText("sections/method.tex:2"));
    expect(onOpenHit).toHaveBeenCalledWith("sections/method.tex", 2);
  });
});
