/**
 * Rewrite with an instruction, without a provider. The selection toolbar
 * suggests four instructions (selection-instruction-menu.tsx); this answers
 * them as written, in English or Simplified Chinese, for the tutorial's worked
 * example, the paragraph the demo marks for trying the agent:
 *
 * - "Use the passive voice" and "Translate into Chinese" give each of its
 *   sentences a written rewrite;
 * - "Translate into academic English" leaves English as it is and turns those
 *   sentences' Chinese back;
 * - "Shorten to about 100 words" keeps whole sentences up to that length.
 *
 * Anything else, or another passage, says plainly that the answers are
 * scripted rather than pretending with an unrelated edit.
 */

/** The answer the task completes with, or the failure it reports. */
export type RewriteAnswer = { text: string; reasons: string[] } | { failure: string };

type Kind = "passive" | "chinese" | "english" | "shorten";

/** Each suggestion as either language words it, and as a writer might retype it. */
const KINDS: Array<[Kind, RegExp]> = [
  ["chinese", /chinese|中文|汉语/i],
  ["english", /english|英文|英语/i],
  ["passive", /passive|被动/i],
  ["shorten", /shorten|shorter|condense|\bcut\b|缩短|精简|压缩/i],
];

/** A sentence as it may read (`english`), as written plainly (`original`), and its two rewrites. */
type Sentence = { english: RegExp; original: string; passive: string; chinese: string };

/**
 * The worked example's sentences: as the tutorial ships, as the demo stages
 * its typos ("For a example query", "teh"), and as Proofread leaves them.
 */
const SENTENCES: Sentence[] = [
  {
    english: /Consider the four-token fragment ``attention connects every position\.''/,
    original: "Consider the four-token fragment ``attention connects every position.''",
    passive: "The four-token fragment ``attention connects every position.'' is considered here.",
    chinese: "考虑由四个词元组成的片段 ``attention connects every position.''。",
  },
  {
    english: /For (?:the|an? example) query at \\emph\{connects\}, suppose the scaled scores are \$\[0\.4,1\.2,0\.1,0\.8\]\$\./,
    original: "For an example query at \\emph{connects}, suppose the scaled scores are $[0.4,1.2,0.1,0.8]$.",
    passive: "For an example query at \\emph{connects}, the scaled scores are taken to be $[0.4,1.2,0.1,0.8]$.",
    chinese: "以 \\emph{connects} 处的查询为例，设缩放后的得分为 $[0.4,1.2,0.1,0.8]$。",
  },
  {
    english: /Applying softmax gives approximately \$\[0\.18,0\.41,0\.14,0\.27\]\$ after rounding\./,
    original: "Applying softmax gives approximately $[0.18,0.41,0.14,0.27]$ after rounding.",
    passive: "Approximately $[0.18,0.41,0.14,0.27]$ is obtained once softmax is applied and the result is rounded.",
    chinese: "应用 softmax 并四舍五入后，结果约为 $[0.18,0.41,0.14,0.27]$。",
  },
  {
    english: /The new representation at \\emph\{connects\} is therefore a convex combination of all four value vectors, with the largest contribution coming from its own value in this illustrative head\./,
    original: "The new representation at \\emph{connects} is therefore a convex combination of all four value vectors, with the largest contribution coming from its own value in this illustrative head.",
    passive: "The new representation at \\emph{connects} is therefore formed as a convex combination of all four value vectors, with the largest contribution made by its own value in this illustrative head.",
    chinese: "因此，\\emph{connects} 处的新表示是全部四个值向量的凸组合；在这个示意性的注意力头中，它自身的值贡献最大。",
  },
  {
    english: /Changing (?:the|teh) softmax temperature alters concentration but not the underlying value vectors; the interactive HTML file in this project lets the reader inspect that distinction\./,
    original: "Changing the softmax temperature alters concentration but not the underlying value vectors; the interactive HTML file in this project lets the reader inspect that distinction.",
    passive: "Concentration is altered by changing the softmax temperature, but the underlying value vectors are not; the interactive HTML file in this project lets the reader inspect that distinction.",
    chinese: "改变 softmax 温度会改变注意力的集中程度，但不会改变底层的值向量；读者可以用本项目中的交互式 HTML 文件查看这一区别。",
  },
];

const CJK = /[\u3400-\u9fff]/;
const WORDS_TARGET = 100;

const scripted = (zh: boolean) => (zh
  ? "演示里的改写是脚本模拟的：它只认得建议的几条指令，并且只改写标有“Demo”的那一段。Mac 上的 Lattice 会让你的 AI 按任意指令改写任意段落。"
  : "Rewrite is scripted in this demo: it knows the suggested instructions, for the paragraph marked “Demo”. Lattice on your Mac has your AI rewrite any passage as you ask.");

/** Each known sentence in `excerpt` replaced by its `to` version, with a reason per sentence. */
function replaceSentences(excerpt: string, find: (sentence: Sentence) => RegExp | string, to: (sentence: Sentence) => string, reason: string): RewriteAnswer | null {
  const reasons: string[] = [];
  let text = excerpt;
  for (const sentence of SENTENCES) {
    const pattern = find(sentence);
    const match = typeof pattern === "string" ? (text.includes(pattern) ? pattern : null) : pattern.exec(text)?.[0];
    if (!match) continue;
    text = text.replace(match, to(sentence));
    reasons.push(`${match} => ${to(sentence)} | ${reason}`);
  }
  return reasons.length ? { text, reasons } : null;
}

/** Whole sentences from the start up to about a hundred words, LaTeX commands not counted. */
function shorten(excerpt: string): RewriteAnswer {
  const words = (text: string) => text.replace(/\\[a-zA-Z]+/g, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  if (words(excerpt) <= WORDS_TARGET * 1.1) return { text: excerpt, reasons: [] };
  const sentences = excerpt.match(/[^.!?]+[.!?]+(?:''|")?\s*/g) ?? [excerpt];
  let kept = "";
  for (const sentence of sentences) {
    if (kept && words(kept + sentence) > WORDS_TARGET) break;
    kept += sentence;
  }
  const cut = excerpt.slice(kept.length).trim();
  return { text: kept.trimEnd(), reasons: cut ? [`${cut} =>  | concision`] : [] };
}

/** The scripted answer to `instruction` for `excerpt`; `zh` words its notes and refusals in Chinese. */
export function rewriteWithInstruction(instruction: string, excerpt: string, zh: boolean): RewriteAnswer {
  const kind = KINDS.find(([, pattern]) => pattern.test(instruction))?.[0];
  const answer = kind === "passive"
    ? replaceSentences(excerpt, (sentence) => sentence.english, (sentence) => sentence.passive, `clarity | ${zh ? "按要求改为被动语态" : "Passive voice, as asked"}`)
    : kind === "chinese"
      ? replaceSentences(excerpt, (sentence) => sentence.english, (sentence) => sentence.chinese, "translation")
      : kind === "english"
        // Already English: nothing to translate, as the prompt says to answer.
        ? CJK.test(excerpt)
          ? replaceSentences(excerpt, (sentence) => sentence.chinese, (sentence) => sentence.original, "translation")
          : { text: excerpt, reasons: [] }
        : kind === "shorten" ? shorten(excerpt) : null;
  return answer ?? { failure: scripted(zh) };
}

