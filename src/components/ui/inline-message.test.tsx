import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { activateAppLocale } from "../../i18n";
import { InlineMessage } from "./inline-message";

describe("InlineMessage", () => {
  it("shows a host error in the interface language", async () => {
    await activateAppLocale("zh-CN");
    // What renaming a label onto one that exists rejects with (project/symbols.rs).
    render(<InlineMessage level="error">The label “fig:model” already exists.</InlineMessage>);
    expect(screen.getByRole("alert")).toHaveTextContent("标签“fig:model”已存在");
  });

  it("keeps any other text as it is", async () => {
    await activateAppLocale("zh-CN");
    render(<InlineMessage level="warning">latexmk exited with status 12</InlineMessage>);
    expect(screen.getByRole("status")).toHaveTextContent("latexmk exited with status 12");
  });
});
