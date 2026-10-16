import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnglishVariant, TermRule } from "../app-types";
import { activateAppLocale } from "../i18n";
import { TermsPanel } from "./terms-panel";

const RULES: TermRule[] = [{ term: "zero-shot", variants: ["zero shot"], note: "Hyphenated." }];
const TEXT = "We study zero shot transfer. Zero shot results follow; $zero shot$ stays.\n";

function renderPanel(rules: TermRule[] = RULES, text = TEXT) {
  const onSaveTerms = vi.fn(async (_rules: TermRule[], _variant: EnglishVariant | null) => true);
  const onApply = vi.fn(async () => true);
  const readSources = vi.fn(async () => [{ path: "sections/intro.tex", text }]);
  const view = render(
    <TermsPanel
      rules={rules}
      englishVariant={null}
      readSources={readSources}
      onSaveTerms={onSaveTerms}
      onApply={onApply}
      onOpen={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return { ...view, onSaveTerms, onApply, readSources };
}

describe("TermsPanel", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it("lists each prose place and counts the one in math as left as written", async () => {
    renderPanel();
    expect(await screen.findByText("2 places to review in 1 file")).toBeInTheDocument();
    expect(screen.getByText("1 more is in math, a comment, a key or a path, and stays as written.")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").filter((item) => item.classList.contains("terms-hit"))).toHaveLength(2);
  });

  it("changes one place as the file was read, under a history label naming the term", async () => {
    const { onApply } = renderPanel();
    await screen.findByText("2 places to review in 1 file");
    const [first] = document.querySelectorAll<HTMLElement>(".terms-hit");
    await act(async () => fireEvent.click(within(first).getByRole("button", { name: "Change" })));
    expect(onApply).toHaveBeenCalledWith("Use “zero-shot”", [{
      path: "sections/intro.tex",
      before: TEXT,
      after: TEXT.replace("study zero shot", "study zero-shot"),
    }]);
  });

  it("remembers a kept place on its rule, and a second Keep builds on the first before it is stored", async () => {
    const { onSaveTerms } = renderPanel();
    await screen.findByText("2 places to review in 1 file");
    onSaveTerms.mockImplementation(() => new Promise(() => {}));
    const keep = () => fireEvent.click(within(document.querySelector<HTMLElement>(".terms-hit")!).getByRole("button", { name: "Keep" }));
    keep();
    expect(await screen.findByText("1 place kept as written")).toBeInTheDocument();
    keep();
    const [rules] = onSaveTerms.mock.calls[1];
    expect(rules[0].skipped).toHaveLength(2);
    expect(screen.getByText("2 places kept as written")).toBeInTheDocument();
  });

  it("refuses a rule whose term another rule already finds", async () => {
    const { onSaveTerms } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByPlaceholderText("zero-shot"), { target: { value: "Zero Shot" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(screen.getByText("The rule for “zero-shot” already covers “Zero Shot”.")).toBeInTheDocument();
    expect(onSaveTerms).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("zero-shot"), { target: { value: "ResNet" } });
    fireEvent.change(screen.getByPlaceholderText("zero shot, zeroshot"), { target: { value: "Resnet，resnet , " } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(onSaveTerms).toHaveBeenCalledWith([...RULES, { term: "ResNet", variants: [], note: "", skipped: [] }], null);
  });
});
