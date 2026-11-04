/**
 * The agent's read-only text tasks without a provider: Proofread and Polish
 * answer after a short pause with a few fixed spelling, agreement and
 * wordiness fixes, and a passage sent for revision from a note gets the
 * canned rewrite for it (annotations.ts), and Rewrite with an instruction
 * gets the scripted answer to that instruction (rewrites.ts), so the inline
 * cards can be tried.
 * Each fix also answers with its reason, as the prompt asks: a category and,
 * for some, a note in the asked language.
 */
import { cannedRevision } from "./annotations";
import { rewriteWithInstruction } from "./rewrites";
import type { Args } from "./tauri-internals";

type Fix = [pattern: RegExp, replacement: string, category?: string, note?: string, noteZh?: string];
const PROOFREAD_FIXES: Fix[] = [
  [/\bteh\b/g, "the", "spelling"],
  [/\bwich\b/g, "which", "spelling"],
  [/\bbeleive\b/g, "believe", "spelling"],
  [/\brecieves?\b/g, "receives", "spelling"],
  [/\boccured\b/g, "occurred", "spelling"],
  [/\bseperate\b/g, "separate", "spelling"],
  [/\bachieve state of the art\b/g, "achieves state-of-the-art", "grammar", "Agreement, and a hyphenated modifier", "主谓一致，复合修饰语加连字符"],
  [/\ba ([aeiou])/g, "an $1", "grammar", "“an” before a vowel sound", "元音前用 an"],
  [/ {2,}/g, " "],
  [/ ,/g, ",", "punctuation", "No space before a comma", "逗号前不空格"],
];
const POLISH_FIXES: Fix[] = [
  [/\bIn this paper,? we show that\b/g, "This paper shows that", "concision"],
  [/\bin order to\b/g, "to", "concision", "Shorter, same meaning", "更简短，意思不变"],
  [/\bdue to the fact that\b/g, "because", "concision"],
  [/\bvery important\b/g, "essential", "word choice", "Stronger than an intensifier", "比加强副词更有力"],
  [/\ba lot of\b/g, "many", "word choice", "Less colloquial", "更书面"],
];
/** Fixes that touch inline math and a citation key, which the card must hold back. */
const UNSAFE_FIXES: Fix[] = [
  [/\$([^$]+)\$/, "$\\hat{$1}$", "consistency"],
  [/\\cite\{([^}]+)\}/, "\\cite{$1-2024}", "consistency"],
];

type Options = {
  /**
   * `failed` fails every task, `unavailable` answers like a runtime that
   * predates the route, `unsafe` also changes the first inline math and
   * citation key; null answers normally.
   */
  mode?: () => string | null;
  /** The model a completed task reports, if any. */
  model?: () => string | null;
};

/** `agent_text_task`'s answer: start a task, then poll it until its pause is over. */
export function textTasks({ mode = () => null, model = () => null }: Options = {}): (args: Args) => unknown {
  const tasks = new Map<string, { text: string; ready: number; failure?: string }>();
  return (args) => {
    const action = String(args?.action ?? "");
    if (action === "start") {
      if (mode() === "unavailable") throw "agent_route_unavailable";
      const prompt = String(args?.prompt ?? "");
      if (prompt.startsWith("Revise a passage")) {
        const taskId = `text-task:${tasks.size + 1}`;
        tasks.set(taskId, { text: annotationReply(prompt), ready: performance.now() + 1_200 + Math.random() * 1_600 });
        return { taskId };
      }
      const excerpt = /<excerpt>\n([\s\S]*)\n<\/excerpt>$/.exec(prompt)?.[1] ?? "";
      const zh = prompt.includes("in Simplified Chinese");
      // The writer's own instruction (agent-proofread.ts `customTask`), never the fixed fixes below.
      const instruction = /^Revise the LaTeX excerpt [^\n]*\n<instruction>\n([\s\S]*?)\n<\/instruction>/.exec(prompt)?.[1];
      if (instruction !== undefined) {
        const answer = rewriteWithInstruction(instruction, excerpt, zh);
        const taskId = `text-task:${tasks.size + 1}`;
        tasks.set(taskId, "failure" in answer
          ? { text: "", failure: answer.failure, ready: performance.now() + 1_200 }
          : { text: reply(answer.text, answer.reasons), ready: performance.now() + 1_600 });
        return { taskId };
      }
      const fixes = [
        ...PROOFREAD_FIXES,
        ...prompt.startsWith("Polish") ? POLISH_FIXES : [],
        ...mode() === "unsafe" ? UNSAFE_FIXES : [],
      ];
      const reasons: string[] = [];
      const fixed = fixes.reduce((text, [pattern, replacement, category, note, noteZh]) => text.replace(pattern, (match) => {
        const revised = match.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement);
        if (category) reasons.push([`${match} => ${revised}`, category, ...note ? [zh ? noteZh : note] : []].join(" | "));
        return revised;
      }), excerpt);
      const taskId = `text-task:${tasks.size + 1}`;
      tasks.set(taskId, { text: reply(fixed, reasons), ready: performance.now() + 1_600 });
      return { taskId };
    }
    const task = tasks.get(String(args?.taskId ?? ""));
    if (!task) throw "Agent task not found.";
    if (action === "cancel") return { status: "running" };
    if (performance.now() < task.ready) return { status: "running" };
    if (mode() === "failed") return { status: "failed", message: "Codex is not signed in." };
    if (task.failure) return { status: "failed", message: task.failure };
    const name = model();
    return { status: "completed", text: task.text, ...name ? { model: name } : {} };
  };
}

/** The agent's reply to a proofread or rewrite: the revised excerpt and a reason per change, between the markers the prompt asks for. */
function reply(text: string, reasons: string[]): string {
  return `Here is the revised excerpt.\n<proofread>\n${text}\n</proofread>\n<reasons>\n${reasons.join("\n")}\n</reasons>`;
}

/** The agent's answer to a note: its canned revision, or a question when asked to cite. */
function annotationReply(prompt: string): string {
  const passage = /<passage>\n([\s\S]*)\n<\/passage>/.exec(prompt)?.[1] ?? "";
  const zh = prompt.includes("in Simplified Chinese");
  if (prompt.includes("<bibliography>")) {
    return `<question>${zh ? "要引用哪篇论文？参考文献里没有直接支持这句话的。" : "Which paper should support this? Nothing in the bibliography states it directly."}</question>`;
  }
  const canned = cannedRevision(passage.trim());
  const text = canned?.text ?? passage.replace(/\bvery\b\s*/g, "").replace(/\bin order to\b/g, "to").replace(/\bdeliberately\b\s*/g, "");
  const reason = canned ? (zh ? canned.reasonZh : canned.reason) : (zh ? "更紧凑，意思不变。" : "Tighter, same meaning.");
  return `<revision>${text}</revision>\n<reason>${reason}</reason>`;
}
