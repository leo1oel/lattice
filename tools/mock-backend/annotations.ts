/**
 * Notes on the tutorial (`.research/annotations.json`), kept in memory, and
 * the agent's canned revisions of the passages they quote, so a revision
 * round can be run without a provider: Revise with agent proposes them, and
 * accepting one writes it into main.tex.
 */
import type { MockProject } from "./project";
import { NOT_HANDLED, type Args } from "./tauri-internals";

export type MockAnnotation = Record<string, unknown> & { id: string; quote: string; revision?: Record<string, unknown> };
type RoundFile = { path: string; before: string | null; after: string | null };

/** The seeded notes: quote, note, intent, minutes ago, and (for one) where it sits on the PDF. */
const SEEDED_ANNOTATIONS: Array<[string, string, string | null, number, boolean?]> = [
  ["Attention turns a collection of token representations into context-sensitive representations by learning which pieces of information should interact.",
    "Too abstract for the opening line; start with what the reader will be able to do", "rewrite", 42],
  ["The Transformer made a stronger design choice", "Say what the choice was before calling it stronger", null, 31],
  ["That choice exposes parallel computation during training", "One line contrasting this with an RNN", "clarify", 20],
  ["The factor $1/\\sqrt{d_k}$ controls score magnitude", "Add one sentence of intuition before the variance argument", null, 12],
  ["Multiplicative variants made this retrieval efficient", "Name the variants (dot-product, general)", "clarify", 1, true],
];

/** The agent's canned answers, by the start of the passage they revise: the revision and its reason. */
const REVISIONS: Array<[string, string, string, string]> = [
  ["Attention turns a collection",
    "This tutorial shows how attention lets each token choose which others to read from, and why that one choice made the Transformer possible. Attention turns a collection of token representations into context-sensitive representations by learning which pieces of information should interact.",
    "Opens with what the reader gets; the definition moves to the next sentence.", "先说读者能得到什么，定义挪到下一句。"],
  ["Multiplicative variants",
    "Multiplicative variants (dot-product and general scoring) made this retrieval efficient",
    "Names the two variants Luong et al. compare.", "点名 Luong 等人比较的两种变体。"],
  ["That choice exposes",
    "Unlike a recurrent network, which must step through tokens one by one, that choice exposes parallel computation during training",
    "Contrasts the Transformer with an RNN in one clause.", "用一个从句对比 RNN。"],
  ["The Transformer made",
    "The Transformer made attention the only path between positions, a stronger design choice",
    "Says what the choice was before judging it.", "先说是什么选择，再评价它。"],
];

/** The canned revision of a passage, if the agent has one for it. */
export function cannedRevision(passage: string) {
  const canned = REVISIONS.find(([start]) => passage.startsWith(start));
  return canned && { text: canned[1], reason: canned[2], reasonZh: canned[3] };
}

type Options = {
  project: MockProject;
  /**
   * Which notes the open project starts with, read when the app first lists
   * them: null for none, `review` for a round in review (proposals, an
   * accepted one and a question) after a settled first round, `rounds` for
   * two settled rounds to compare, anything else for five open notes (one
   * made on the PDF).
   */
  seed: () => string | null;
  /** Numbers the seeds from this + 1, for wide pins. */
  numberBase?: number;
  /** More notes to seed, numbered after the others. */
  extra?: (main: string, numberBase: number) => MockAnnotation[];
  /** Whether the agent answers in Simplified Chinese. */
  zh: () => boolean;
};

/** The annotation commands' answer, or `NOT_HANDLED` for any other command. */
export function annotationsAnswer({ project, seed, numberBase = 0, extra, zh }: Options): (command: string, args: Args) => unknown {
  let state: { annotations: MockAnnotation[]; rounds: Array<Record<string, unknown>> } | null = null;
  const roundFiles = new Map<number, RoundFile[]>();

  const seeded = () => {
    if (state) return state;
    const mode = seed();
    if (!mode) return { annotations: [], rounds: [] };
    const main = project.text("main.tex");
    const annotations = SEEDED_ANNOTATIONS.flatMap(([quote, body, intent, minutes, pdf], index): MockAnnotation[] => {
      const from = main.indexOf(quote);
      if (from < 0) return [];
      const at = new Date(Date.now() - minutes * 60_000).toISOString();
      return [{
        id: `bench-annotation-${index + 1}`, number: numberBase + index + 1, path: "main.tex", from, to: from + quote.length, quote,
        prefix: main.slice(Math.max(0, from - 32), from), suffix: main.slice(from + quote.length, from + quote.length + 32),
        body, ...intent ? { intent } : {},
        ...pdf ? { pdf: { page: 1, rects: [{ x: 0.408, y: 0.552, width: 0.322, height: 0.0125 }], text: quote } } : {},
        authorId: "me", authorName: "Leo", resolved: false, replies: [], createdAt: at, updatedAt: at,
      }];
    });
    if (extra) annotations.push(...extra(main, numberBase + annotations.length));
    const rounds: Array<Record<string, unknown>> = [];
    if (mode === "review" || mode === "rounds") {
      const settled = (number: number, hoursAgo: number) => ({
        number, startedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
        settledAt: new Date(Date.now() - (hoursAgo - 0.2) * 3_600_000).toISOString(), outcomes: {} as Record<string, string>,
        historyId: `bench-round-${number}`,
      });
      const before = main.replace("A sequence model must decide how information at one position can influence another.",
        "A sequence model has to decide, at every step, how information at one position can influence another one.");
      const first = settled(1, 3);
      first.outcomes = { "bench-old-1": "accepted", "bench-old-2": "accepted" };
      roundFiles.set(1, [{ path: "main.tex", before, after: main }]);
      rounds.push(first);
      if (mode === "rounds") {
        const second = settled(2, 1);
        second.outcomes = { "bench-annotation-2": "accepted", "bench-annotation-3": "rejected" };
        const after = main.replace("The Transformer made a stronger design choice", REVISIONS[3]![1]);
        roundFiles.set(2, [{ path: "main.tex", before: main, after }]);
        project.files.set("main.tex", after);
        rounds.push(second);
      } else {
        const chinese = zh();
        const open = { number: 2, startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), outcomes: {} as Record<string, string> };
        for (const annotation of annotations) {
          const number = (annotation.number as number) - numberBase;
          const canned = cannedRevision(annotation.quote);
          const reason = canned && (chinese ? canned.reasonZh : canned.reason);
          if (number === 4) {
            annotation.revision = { round: 2, state: "asked", question: chinese ? "直觉放在式 (2) 之前还是之后？" : "Should the intuition go before equation (2) or after it?" };
          } else if (number === 2 && canned) {
            annotation.revision = { round: 2, state: "accepted", original: annotation.quote, text: canned.text, reason };
            annotation.resolved = true;
          } else if (canned) {
            annotation.revision = { round: 2, state: "proposed", original: annotation.quote, text: canned.text, reason };
          }
          if (annotation.revision) open.outcomes[annotation.id] = String(annotation.revision.state);
        }
        roundFiles.set(2, [{ path: "main.tex", before: main, after: null }]);
        rounds.push(open);
      }
    }
    state = { annotations, rounds };
    return state;
  };

  return (command, args) => {
    switch (command) {
      case "list_annotations":
        return seeded();
      case "save_annotations":
        state = { annotations: (args?.annotations as MockAnnotation[]) ?? [], rounds: (args?.rounds as Array<Record<string, unknown>>) ?? [] };
        return null;
      case "save_annotation_round": {
        const number = Number(args?.number);
        roundFiles.set(number, (args?.files as RoundFile[]) ?? []);
        return args?.settled ? `bench-round-${number}` : null;
      }
      case "read_annotation_round":
        return roundFiles.get(Number(args?.number)) ?? [];
      case "restore_annotation_round":
        for (const file of (args?.files as Array<{ path: string; after: string | null }>) ?? []) {
          if (typeof file.after === "string") project.files.set(file.path, file.after);
        }
        return null;
      default:
        return NOT_HANDLED;
    }
  };
}
