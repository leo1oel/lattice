import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";
import { Field } from "./field";
import { Input } from "./input";
import { SettingsSectionHeader } from "./settings-section-header";

afterEach(cleanup);

describe("shared UI patterns", () => {
  it("renders a Settings heading and aligned action", () => {
    render(
      <SettingsSectionHeader
        title="Appearance"
        description="Preferences for this Mac."
        actions={<button type="button">Reset</button>}
      />,
    );

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("associates a shared Field label with its control", () => {
    render(
      <Field label="Project name" htmlFor="project-name" hint="Shown in the title bar.">
        <Input id="project-name" controlSize="form" />
      </Field>,
    );

    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
    expect(screen.getByText("Shown in the title bar.")).toBeInTheDocument();
  });

  it("renders an empty state without imposing a heading when none is needed", () => {
    render(<EmptyState description="No results." density="compact" />);

    expect(screen.getByText("No results.")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
