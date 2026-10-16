/**
 * The bench's answers for a linked Overleaf project, so the collaboration
 * surfaces (the Overleaf panel, margin review in the source, presence) can be
 * looked at with data.
 *
 * `?overleaf=review` on the tutorial (`&tutorial=1`) links it to Overleaf on
 * the live channel: comment threads anchored in main.tex (one resolved, one
 * whose text was deleted) and references.bib, tracked changes in main.tex
 * from three people, chat and presence. `?overleaf=long` gives the same with
 * 45-character names and an unbroken URL in a comment, for width checks.
 * `?overleaf=expired` keeps the link but has Overleaf turn the stored session
 * away, the state Settings offers to reconnect from; `expired-long` gives the
 * account a 45-character address. `?overleaf=offline` links it but never
 * reaches the live channel, as with the network down.
 * The comments are in the page's language (`?lang=`).
 */
export const NOT_HANDLED = Symbol("not handled");

type Context = {
  params: URLSearchParams;
  /** The page's interface language. */
  lang: string | null;
  /** The open project's text files by path. */
  text: (path: string) => string;
  emit: (event: string, payload: unknown) => void;
  root: () => string;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DOCS = [
  { id: "doc-main", path: "main.tex" },
  { id: "doc-bib", path: "references.bib" },
  { id: "doc-notes", path: "notes.md" },
];

type Person = { id: string; name: string; email: string; hue: number; first: string; last: string };

const PEOPLE = {
  mina: { id: "u-mina", name: "Mina Park", email: "mina.park@example.edu", hue: 205, first: "Mina", last: "Park" },
  alex: { id: "u-alex", name: "Alex Chen", email: "alex.chen@example.edu", hue: 28, first: "Alex", last: "Chen" },
  sofia: { id: "u-sofia", name: "Sofia Rossi", email: "sofia.rossi@example.org", hue: 318, first: "Sofia", last: "Rossi" },
  me: { id: "u-me", name: "Leo Gu", email: "leo@example.edu", hue: 140, first: "Leo", last: "Gu" },
} satisfies Record<string, Person>;

const LONG_NAME = "Maximiliane Alexandra von Hohenberg-Schönfeld";
const LONG_TEXT = "See https://www.overleaf.com/project/64f1c2a9b8e7d6c5a4b3f2e1/detacher?section=related-work&anchor=efficient-attention-kernels-and-their-hardware-aware-implementations for the full discussion";

type Seed = {
  id: string;
  doc: string | null;
  quote: string;
  resolvedBy?: string;
  messages: Array<[Person, string, string, number]>;
};

/** Threads: their span (a quote in the doc's text) and messages as [author, English, Chinese, age]. */
const THREADS: Seed[] = [
  {
    id: "t-1", doc: "doc-main", quote: "Attention turns a collection of token representations into context-sensitive representations",
    messages: [
      [PEOPLE.mina, "This opening is abstract. Could we lead with what the reader will be able to do?", "开头这句太抽象了，能不能先说读者能学到什么？", 3 * HOUR],
      [PEOPLE.me, "Agreed. I'll open with the worked example instead.", "同意，我改成先讲一个例子。", 2.6 * HOUR],
      [PEOPLE.alex, "Point at Figure 1 — it's exactly the 4×4 example.", "可以引用图 1，正好是那个 4×4 的例子。", 2.1 * HOUR],
    ],
  },
  {
    id: "t-2", doc: "doc-main", quote: "creating a path whose length grows with token distance",
    messages: [[PEOPLE.alex, "Needs a citation here — Hochreiter 1991 or Bengio 1994.", "这里需要一个引用，Hochreiter 1991 或者 Bengio 1994。", 50 * MINUTE]],
  },
  {
    id: "t-3", doc: "doc-main", quote: "producing quadratic time and memory growth in sequence length",
    messages: [
      [PEOPLE.sofia, "Worth giving a number? Memory at 32k tokens, say.", "要不要给一个具体数字？比如 32k token 时的显存。", 25 * MINUTE],
      [PEOPLE.mina, "A footnote is enough; keep the body lean.", "加在脚注里就好，正文保持简洁。", 12 * MINUTE],
    ],
  },
  {
    id: "t-4", doc: "doc-bib", quote: "Neural Machine Translation by Jointly Learning to Align and Translate",
    messages: [[PEOPLE.mina, "This should be the ICLR 2015 proceedings version.", "这条应该是 ICLR 2015 的会议版本。", 5 * HOUR]],
  },
  {
    id: "t-5", doc: "doc-main", quote: "The row-wise softmax converts those scores into non-negative weights", resolvedBy: "Alex Chen",
    messages: [
      [PEOPLE.alex, "\"Non-negative and sum to one\" is said twice.", "“非负且和为一”说两遍了。", 26 * HOUR],
      [PEOPLE.me, "Removed the second one.", "已删掉第二处。", 25 * HOUR],
    ],
  },
  {
    id: "t-6", doc: null, quote: "",
    messages: [[PEOPLE.sofia, "Where did the ablation paragraph we discussed go?", "我们之前讨论的那段消融实验去哪了？", 2 * DAY]],
  },
];

function threads(context: Context) {
  const long = context.params.get("overleaf") === "long";
  const zh = context.lang === "zh-CN";
  return THREADS.map((seed) => ({
    id: seed.id,
    resolved: seed.resolvedBy !== undefined,
    resolvedBy: seed.resolvedBy === undefined ? null : long ? LONG_NAME : seed.resolvedBy,
    resolvedAt: seed.resolvedBy === undefined ? null : new Date(Date.now() - DAY).toISOString(),
    messages: seed.messages.map(([person, english, chinese, ago], index) => ({
      id: `${seed.id}-m${index}`,
      content: long && index === 0 ? LONG_TEXT : zh ? chinese : english,
      authorName: long && person !== PEOPLE.me ? LONG_NAME : person.name,
      authorEmail: person.email,
      timestamp: Date.now() - ago,
      mine: person === PEOPLE.me,
    })),
  }));
}

function anchors(context: Context) {
  return THREADS.flatMap((seed) => {
    const doc = DOCS.find((item) => item.id === seed.doc);
    const position = doc ? context.text(doc.path).indexOf(seed.quote) : -1;
    return doc && position >= 0 ? [{ threadId: seed.id, docId: doc.id, position, quote: seed.quote }] : [];
  });
}

/** Suggestions in main.tex. A suggested deletion's text is still in the document (overleaf-editor-extensions.ts). */
function trackedChanges(context: Context) {
  const main = context.text("main.tex");
  const changes: Array<Record<string, unknown>> = [];
  const add = (phrase: string, around: string, deletion: boolean, person: Person, ago: number) => {
    const at = main.indexOf(around);
    if (at < 0) return;
    changes.push({
      id: `c-${changes.length + 1}`, position: at + around.indexOf(phrase), text: phrase, deletion,
      userId: person.id, timestamp: new Date(Date.now() - ago).toISOString(), hue: person.hue,
    });
  };
  add("deliberately ", "The manuscript is deliberately written", false, PEOPLE.mina, 40 * MINUTE);
  add(", creating a path whose length grows with token distance", ", creating a path whose length grows with token distance", true, PEOPLE.alex, 33 * MINUTE);
  add("principal ", "attention became the principal mechanism", false, PEOPLE.sofia, 18 * MINUTE);
  add("roughly ", "roughly ", true, PEOPLE.mina, 9 * MINUTE);
  return changes;
}

function chat(context: Context) {
  const zh = context.lang === "zh-CN";
  const lines: Array<[Person, string, string, number]> = [
    [PEOPLE.mina, "Morning! I'll go through Section 2 this afternoon.", "早！我今天下午过一遍第 2 节。", 6 * HOUR],
    [PEOPLE.alex, "I'm fixing citations — a few bib entries are still arXiv versions.", "我在补引用，bib 里有几条还是 arXiv 版本。", 5.5 * HOUR],
    [PEOPLE.me, "Great. I'll redo the abstract first and ping you in the comments.", "好，我先改摘要，改完在评论里 @ 你们。", 5.4 * HOUR],
    [PEOPLE.alex, "Before the deadline we still need the appendix under two pages.", "截稿前还要把附录压到两页以内。", 40 * MINUTE],
  ];
  return lines.map(([person, english, chinese, ago], index) => ({
    id: `chat-${index}`, content: zh ? chinese : english, authorName: person.name, authorEmail: person.email,
    timestamp: Date.now() - ago, mine: person === PEOPLE.me,
  }));
}

function presence() {
  return [PEOPLE.mina, PEOPLE.alex, PEOPLE.sofia].map((person, index) => ({
    id: `conn-${index}`, userId: person.id, name: person.name, email: person.email,
    docId: index === 1 ? "doc-bib" : "doc-main", row: 20 + index * 9, column: 4, hue: person.hue,
  }));
}

export function overleafAnswer(command: string, args: Record<string, unknown> | undefined, context: Context): unknown {
  const mode = context.params.get("overleaf") ?? "";
  if (!["review", "long", "expired", "expired-long", "offline"].includes(mode)) return NOT_HANDLED;
  const entities = DOCS.map((doc) => ({ ...doc, kind: "doc" }));
  switch (command) {
    case "overleaf_status": {
      const expired = mode.startsWith("expired");
      const email = mode === "expired-long" ? "leonardo.researcher.long.name@mails.example.edu" : PEOPLE.me.email;
      return { connected: !expired, expired, email, name: PEOPLE.me.name, host: "https://www.overleaf.com" };
    }
    case "overleaf_link":
      return {
        projectId: "ol-understanding-attention", projectName: "Understanding Attention", host: "https://www.overleaf.com",
        lastSync: new Date(Date.now() - 4 * MINUTE).toISOString(), paused: false,
      };
    case "overleaf_probe":
      return { changed: false, localChanged: false, versionKnown: true, remoteVersion: 143, lastSync: new Date(Date.now() - 4 * MINUTE).toISOString() };
    case "overleaf_rt_connect":
      if (mode === "offline") throw new Error("The network connection was lost.");
      // The channel names our connection and the tree once it is up, which seeds presence.
      setTimeout(() => {
        const projectRoot = context.root();
        context.emit("overleaf-realtime", { projectRoot, type: "connected", publicId: "conn-me" });
        context.emit("overleaf-realtime", { projectRoot, type: "treeChanged", docs: DOCS, entities });
      }, 400);
      return { publicId: "conn-me", docs: DOCS, entities, permission: "owner" };
    case "overleaf_rt_join_doc": {
      const doc = DOCS.find((item) => item.id === args?.docId);
      const comments = doc
        ? anchors(context).filter((anchor) => anchor.docId === doc.id).map(({ threadId, position, quote }) => ({ threadId, position, quote }))
        : [];
      return {
        text: doc ? context.text(doc.path) : "", version: 10, comments,
        changes: doc?.id === "doc-main" ? trackedChanges(context) : [], caughtUp: [], resumed: false,
      };
    }
    case "overleaf_rt_leave_doc":
    case "overleaf_rt_disconnect":
    case "overleaf_rt_update_position":
    case "overleaf_rt_send_ops":
    case "overleaf_set_permission":
      return null;
    case "overleaf_threads":
      return threads(context);
    case "overleaf_comment_anchors":
      return anchors(context);
    case "overleaf_chat_messages":
      return chat(context);
    case "overleaf_rt_connected_users":
      return presence();
    case "overleaf_change_authors":
      return { users: Object.values(PEOPLE).map((person) => ({ id: person.id, email: person.email, first_name: person.first, last_name: person.last })) };
    case "overleaf_sync":
      return { pulled: [], pushed: [], merged: [], conflicts: [], deletedLocal: [], skippedRemoteDeletes: [], refusedIncoming: [] };
    default:
      return NOT_HANDLED;
  }
}
