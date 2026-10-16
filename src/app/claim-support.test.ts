import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { notifyInfo } from "../telemetry/app-notify";
import { annotationRounds, type AnnotationRoundsDeps } from "./annotation-rounds";
import { ClaimSupport, type ClaimSupportDeps, type SupportClaim } from "./claim-support";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const notifyMock = vi.mocked(notifyInfo);

const MAIN = "\\section{Intro}\nAttention weights are not an explanation of a prediction.\nMore.\n";
const CLAIM: SupportClaim = {
  path: "main.tex", line: 2, from: 16, to: 73, quote: "Attention weights are not an explanation of a prediction.",
  prefix: "\\section{Intro}\n", suffix: "\nMore.\n",
};
const HITS = [
  { source: "openalex", title: "Attention is not Explanation", authors: ["Sarthak Jain", "Byron C. Wallace"], year: 2019, venue: "NAACL", doi: "10.18653/v1/n19-1357", abstract: "We find that attention weights are frequently uncorrelated with feature importance. Other things." },
  { source: "openalex", title: "Is Attention Interpretable?", authors: ["Sofia Serrano"], year: 2019, arxivId: "1906.03731", abstract: "Attention noisily predicts importance. It is no fail-safe indicator." },
  { source: "openalex", title: "Unrelated", authors: [], year: 2020, abstract: "Something else entirely." },
];
const JUDGED = "<support>{\"papers\":[{\"id\":\"p1\",\"signal\":\"supports\",\"passage\":\"We find that attention weights are frequently uncorrelated with feature importance.\"},{\"id\":\"p2\",\"signal\":\"mixed\",\"passage\":\"It is no fail-safe indicator.\"},{\"id\":\"p3\",\"signal\":\"supports\",\"passage\":\"Not in it.\"}]}</support>";

let support: ClaimSupport;
let deps: ClaimSupportDeps;
let replies: string[];
let prompts: string[];
let library: PaperSummary[];

/** Let `work`'s agent tasks poll to their answers. */
async function settled<T>(work: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(5_000);
  return work;
}

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  replies = ["<terms>attention explanation faithfulness</terms>", JUDGED];
  prompts = [];
  library = [{ arxivId: "1906.03731", title: "Is attention interpretable", citationKey: "serrano2019", hasFullText: true, hasBlog: false }];
  const root = { current: "/p" as string | null };
  annotationRounds.attach({ projectRootRef: root, activeFileRef: { current: "" }, sourceRef: { current: "" } } as unknown as AnnotationRoundsDeps);
  let task = 0;
  const texts = new Map<string, string>();
  invokeMock.mockImplementation(async (command, args) => {
    const request = args as Record<string, unknown>;
    if (command === "read_project_file") return MAIN;
    if (command === "search_literature_abstracts") return HITS;
    if (command === "agent_text_task") {
      if (request.action === "start") {
        task += 1;
        prompts.push(String(request.prompt));
        texts.set(`t${task}`, replies.shift() ?? "");
        return { taskId: `t${task}` };
      }
      return { status: "completed", text: texts.get(String(request.taskId)) };
    }
    return null;
  });
  support = new ClaimSupport();
  deps = {
    projectRootRef: root,
    openPanel: vi.fn(),
    openProjectFile: vi.fn(async () => {}),
    library: () => library,
    addCitation: vi.fn(async () => "jain2019attention"),
    addToPapers: vi.fn(async () => "jain2019attention"),
    citeAfter: vi.fn(async () => "cited" as const),
    searchLiterature: vi.fn(),
  };
  support.attach(deps);
});

describe("finding support", () => {
  it("asks for keywords, searches with them, and keeps the papers whose passage is in their abstract", async () => {
    await settled(support.find(CLAIM));
    expect(deps.openPanel).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("search_literature_abstracts", { query: "attention explanation faithfulness" });
    expect(prompts[0]).toContain("<claim>Attention weights are not an explanation of a prediction.</claim>");
    expect(prompts[1]).toMatch(/<context>[^<]*Attention weights are not an explanation of a prediction\. More\.<\/context>/);
    const { result, run, claim } = support.getSnapshot();
    expect(run).toBeNull();
    expect(claim?.text).toBe("Attention weights are not an explanation of a prediction.");
    expect(result?.read).toBe(3);
    expect(result?.papers.map((paper) => [paper.title, paper.signal, paper.inPapers, paper.key])).toEqual([
      ["Attention is not Explanation", "supports", false, undefined],
      ["Is Attention Interpretable?", "mixed", true, "serrano2019"],
    ]);
  });

  it("skips the keywords the review already named, and says why a search failed", async () => {
    replies = ["no list here"];
    await settled(support.find({ ...CLAIM, terms: "attention faithfulness" }));
    expect(prompts).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("search_literature_abstracts", { query: "attention faithfulness" });
    expect(support.getSnapshot().error).toBe("The agent's answer could not be read. Try again.");
  });

  it("drops a search the writer replaced with another", async () => {
    replies = [JUDGED];
    const first = support.find(CLAIM);
    const second = support.find({ ...CLAIM, terms: "attention" });
    await settled(Promise.all([first, second]));
    expect(support.getSnapshot().result?.terms).toBe("attention");
  });
});

describe("acting on a paper", () => {
  it("cites a new paper after adding its entry, and an existing one by its key", async () => {
    await settled(support.find(CLAIM));
    await support.cite("p1");
    expect(deps.addCitation).toHaveBeenCalledWith("10.18653/v1/n19-1357");
    expect(deps.citeAfter).toHaveBeenCalledWith(expect.objectContaining({ path: "main.tex", from: 16 }), "jain2019attention");
    expect(support.getSnapshot().result?.papers[0]).toMatchObject({ key: "jain2019attention", cited: true });
    await support.cite("p2");
    expect(deps.addCitation).toHaveBeenCalledTimes(1);
    expect(deps.citeAfter).toHaveBeenLastCalledWith(expect.anything(), "serrano2019");
    expect(support.getSnapshot().busy.size).toBe(0);
  });

  it("says where the citation went when the claim has moved", async () => {
    vi.mocked(deps.citeAfter).mockResolvedValue("moved");
    await settled(support.find(CLAIM));
    await support.cite("p1");
    expect(support.getSnapshot().result?.papers[0].cited).toBeUndefined();
    expect(notifyMock).toHaveBeenCalledWith("Find support", expect.stringContaining("\\citep{jain2019attention}"), expect.anything());
  });

  it("adds a paper to Papers by its arXiv id, and sets one aside with an Undo", async () => {
    await settled(support.find(CLAIM));
    library = [];
    await support.add("p2");
    expect(deps.addToPapers).toHaveBeenCalledWith("arXiv:1906.03731");
    support.dismiss("p1");
    expect(support.getSnapshot().result?.papers[0].dismissed).toBe(true);
    notifyMock.mock.calls.at(-1)?.[2]?.primaryAction?.onClick();
    expect(support.getSnapshot().result?.papers[0].dismissed).toBe(false);
    support.searchFurther();
    expect(deps.searchLiterature).toHaveBeenCalledWith("attention explanation faithfulness");
  });
});
