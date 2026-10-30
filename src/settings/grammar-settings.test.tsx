import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { grammarSettingsStore } from "../editor/grammar-settings-store";
import { GrammarSettingsGroup } from "./grammar-settings";
import { grammarRuleLabel } from "./grammar-rule-reasons";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const RULES = [
  { name: "AnA", description: "Use `an` before a vowel sound.", defaultOn: true, academicOff: false },
  { name: "BoringWords", description: "Flags overused words.", defaultOn: false, academicOff: false },
  { name: "LongSentences", description: "Flags long sentences.", defaultOn: true, academicOff: true },
  { name: "OxfordComma", description: "Asks for a serial comma.", defaultOn: true, academicOff: true },
];

beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(RULES); });
afterEach(() => {
  cleanup();
  const { setDialect, setProfile, resetRules } = grammarSettingsStore.getState();
  setDialect("american");
  setProfile("auto");
  resetRules();
});

const switchFor = (label: string) => screen.getByRole("switch", { name: label });

it("names rules readably", () => {
  expect(grammarRuleLabel("PhrasalVerbAsCompoundNoun")).toBe("Phrasal verb as compound noun");
  expect(grammarRuleLabel("ExpandMemoryShorthands")).toBe("Expand memory shorthands");
});

it("lists what the academic profile turns off with its reason, and finds any rule by a filter", async () => {
  render(<GrammarSettingsGroup ignores={null} onIgnoresChange={vi.fn()} />);
  expect(await screen.findByText("Long sentences")).toBeInTheDocument();
  expect(screen.getByText(/^Off for academic writing: The serial comma/)).toBeInTheDocument();
  expect(switchFor("Oxford comma")).not.toBeChecked();
  expect(screen.queryByText("An a")).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Filter grammar rules"), { target: { value: "vowel" } });
  expect(screen.getByText("Use an before a vowel sound.")).toBeInTheDocument();
  expect(screen.queryByText("Long sentences")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Filter grammar rules"), { target: { value: "zzz" } });
  expect(screen.getByText("No rule matches “zzz”")).toBeInTheDocument();
});

it("switches a rule over the profile, gives it back when it matches again, and resets", async () => {
  render(<GrammarSettingsGroup ignores={null} onIgnoresChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("switch", { name: "Oxford comma" }));
  expect(grammarSettingsStore.getState().rules).toEqual({ OxfordComma: true });
  expect(switchFor("Oxford comma")).toBeChecked();
  fireEvent.click(switchFor("Oxford comma"));
  expect(grammarSettingsStore.getState().rules).toEqual({});

  fireEvent.click(switchFor("Long sentences"));
  expect(screen.getByText("1 changed from the grammar style")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(grammarSettingsStore.getState().rules).toEqual({});

  // Under the standard profile nothing is off for academic writing.
  grammarSettingsStore.getState().setProfile("standard");
  expect(await screen.findByText("Asks for a serial comma.")).toBeInTheDocument();
  expect(switchFor("Oxford comma")).toBeChecked();
});

it("lists the project's ignored rules and sentences and checks one again", async () => {
  const onIgnoresChange = vi.fn();
  const ignores = { rules: ["OxfordComma"], sentences: ["We test this hypothesis."] };
  render(<GrammarSettingsGroup ignores={ignores} onIgnoresChange={onIgnoresChange} />);
  expect(screen.getByRole("list", { name: "Ignored grammar rules" })).toHaveTextContent("Oxford comma");
  fireEvent.click(screen.getByRole("button", { name: "Check this sentence again" }));
  expect(onIgnoresChange).toHaveBeenLastCalledWith({ rules: ["OxfordComma"], sentences: [] });
  fireEvent.click(screen.getByRole("button", { name: "Check Oxford comma again" }));
  expect(onIgnoresChange).toHaveBeenLastCalledWith({ rules: [], sentences: ["We test this hypothesis."] });
});

it("says where ignores come from", () => {
  const { rerender } = render(<GrammarSettingsGroup ignores={null} onIgnoresChange={vi.fn()} />);
  expect(screen.getByText("Open a project to ignore rules or sentences")).toBeInTheDocument();
  rerender(<GrammarSettingsGroup ignores={{ rules: [], sentences: [] }} onIgnoresChange={vi.fn()} />);
  expect(screen.getByText("Choose Ignore on a grammar suggestion to add one")).toBeInTheDocument();
});
