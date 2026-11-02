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

/** Another window's write to the storage every window shares, and (unless still in flight) the event that reports it. */
function writeFromAnotherWindow(key: string, value: string, { announce = true } = {}) {
  const oldValue = localStorage.getItem(key);
  localStorage.setItem(key, value);
  if (announce) window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: value }));
}

it("follows a rule another window switched off, and keeps it when this window changes the dialect", async () => {
  const store = await load();
  // Window A turns PassiveVoice off after this window opened.
  writeFromAnotherWindow("lattice.grammar.v1", JSON.stringify({ dialect: "american", profile: "auto", rules: { PassiveVoice: false } }));
  expect(store.getState().rules).toEqual({ PassiveVoice: false });

  store.getState().setDialect("british");
  expect(JSON.parse(localStorage.getItem("lattice.grammar.v1") ?? "null")).toEqual({
    dialect: "british", profile: "auto", rules: { PassiveVoice: false },
  });
});

it("never writes back a rule set it has not heard about yet", async () => {
  const store = await load();
  writeFromAnotherWindow("lattice.grammar.v1", JSON.stringify({
    dialect: "american", profile: "standard", rules: { PassiveVoice: false },
  }), { announce: false });

  store.getState().setRule("OxfordComma", true);
  expect(JSON.parse(localStorage.getItem("lattice.grammar.v1") ?? "null")).toEqual({
    dialect: "american", profile: "standard", rules: { PassiveVoice: false, OxfordComma: true },
  });
  expect(store.getState()).toMatchObject({ profile: "standard", rules: { PassiveVoice: false, OxfordComma: true } });
});
