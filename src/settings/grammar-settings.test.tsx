import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { grammarSettingsStore } from "../editor/grammar-settings-store";
import { activateAppLocale } from "../i18n";
import { GrammarSettingsGroup } from "./grammar-settings";

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

it("lists what the academic profile turns off with its reason, and finds any rule by a filter", async () => {
  render(<GrammarSettingsGroup ignores={null} onIgnoresChange={vi.fn()} />);
  expect(await screen.findByText("Long sentences")).toBeInTheDocument();
  expect(screen.getByText(/^Off for academic writing: The serial comma/)).toBeInTheDocument();
  expect(switchFor("Oxford comma")).not.toBeChecked();
  expect(screen.queryByText("An a")).not.toBeInTheDocument();
  expect(screen.getByText(/There are 4 rules in all; type in the filter to search every one/)).toBeInTheDocument();

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

  // The standard profile changes no rule, so only a filter lists one.
  grammarSettingsStore.getState().setProfile("standard");
  await vi.waitFor(() => expect(screen.queryByText("Oxford comma")).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("Filter grammar rules"), { target: { value: "serial" } });
  expect(screen.getByText("Asks for a serial comma.")).toBeInTheDocument();
  expect(switchFor("Oxford comma")).toBeChecked();
});

it("names and finds rules in Chinese as well as English", async () => {
  await activateAppLocale("zh-CN");
  render(<GrammarSettingsGroup ignores={{ rules: ["AnA"], sentences: [] }} onIgnoresChange={vi.fn()} />);
  expect(await screen.findByRole("switch", { name: "标点：牛津逗号" })).not.toBeChecked();
  expect(screen.getByText(/^学术写作中关闭：是否使用连续逗号/)).toBeInTheDocument();
  expect(screen.getByText("这里只列出语法风格或你改动过的规则。共有 4 条规则，在筛选框中输入即可搜索全部规则。")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "已忽略的语法规则" })).toHaveTextContent("冠词：a 与 an");

  const filter = screen.getByRole("textbox");
  fireEvent.change(filter, { target: { value: "冠词" } });
  expect(screen.getByRole("switch", { name: "冠词：a 与 an" })).toBeChecked();
  expect(screen.getByText("检查用错的不定冠词。例如 “this is an mule” 会被标为错误。")).toBeInTheDocument();
  fireEvent.change(filter, { target: { value: "boring" } });
  expect(screen.getByRole("switch", { name: "文体：乏味词语" })).not.toBeChecked();
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
