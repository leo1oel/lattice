import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const load = async () => (await import("./grammar-settings-store")).grammarSettingsStore;

it("reads only the choices it knows from storage and writes every change back", async () => {
  localStorage.setItem("lattice.grammar.v1", JSON.stringify({
    dialect: "british", profile: "casual", rules: { OxfordComma: true, LongSentences: "yes" },
  }));
  const store = await load();
  expect(store.getState()).toMatchObject({ dialect: "british", profile: "auto", rules: { OxfordComma: true } });

  store.getState().setProfile("standard");
  store.getState().setRule("SplitWords", false);
  store.getState().setRule("OxfordComma", null);
  expect(JSON.parse(localStorage.getItem("lattice.grammar.v1") ?? "null")).toEqual({
    dialect: "british", profile: "standard", rules: { SplitWords: false },
  });
});

it("falls back to American English, the automatic profile and no rule changes", async () => {
  localStorage.setItem("lattice.grammar.v1", "{not json");
  expect((await load()).getState()).toMatchObject({ dialect: "american", profile: "auto", rules: {} });
});
