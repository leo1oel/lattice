import { expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
import { grammarFinding, grammarRuleLabel, grammarRuleText, loadGrammarRuleCatalog } from "./grammar-rule-text";
import { createHarperDiagnostic } from "./harper-spellcheck";

const finding = (rule: string, message: string) =>
  createHarperDiagnostic({ from: 0, to: 4, message, kind: "Usage", suggestions: [], rule });
const rendered = (diagnostic: ReturnType<typeof finding>) => {
  const node = diagnostic.renderMessage?.({} as never);
  if (!node) throw new Error("no rendered message");
  return node;
};

it("names rules readably in English and keeps Harper's own sentence", async () => {
  expect(grammarRuleLabel("PhrasalVerbAsCompoundNoun")).toBe("Phrasal verb as compound noun");
  expect(grammarRuleLabel("ExpandMemoryShorthands")).toBe("Expand memory shorthands");
  await loadGrammarRuleCatalog();
  expect(grammarRuleText("AnA", "Flags `an mule`.")).toEqual({ name: "An a", description: "Flags an mule." });
  expect(grammarFinding("AnA", "Incorrect indefinite article.")).toBeNull();
  expect(rendered(finding("AnA", "Incorrect indefinite article.")).textContent).toBe("Incorrect indefinite article.");
});

it("names rules in Chinese and translates the sentence shapes it knows", async () => {
  await activateAppLocale("zh-CN");
  await loadGrammarRuleCatalog();
  expect(grammarRuleText("OxfordComma", "The Oxford comma is …").name).toBe("标点：牛津逗号");
  expect(grammarFinding("SpellCheck", "Did you mean `there`?")).toEqual({
    name: "拼写检查",
    description: "查找拼错的单词并给出更正建议。",
    detail: "你是想写 “there” 吗？",
    translated: true,
  });
  expect(grammarFinding("LongSentences", "This sentence is 52 words long.")?.detail).toBe("这个句子有 52 个词。");

  const node = rendered(finding("Regionalisms", "`lorry` isn't used in American English. Use `truck` instead."));
  const parts = [...node.childNodes].map((part) => [(part as HTMLElement).className, part.textContent, (part as HTMLElement).lang]);
  expect(parts).toEqual([
    ["cm-harper-rule", "方言：地区性用词", ""],
    ["cm-harper-rule-description", "标出所选英语变体中不使用的地区性用词，并建议该变体的对应说法。", ""],
    // No invented translation: Harper's sentence stays, marked as English.
    ["cm-harper-detail cm-harper-detail-original", "“lorry” isn't used in American English. Use “truck” instead.", "en"],
  ]);
});
