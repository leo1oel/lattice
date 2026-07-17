# Original writing

Part of the user's writing guide, the from-scratch mode.

Use this when writing from sources, experiments, or notes rather than reworking text that already exists.
This mode covers two jobs: building an argument that holds up, and getting it down in clear prose.

## Start from one claim

- Decide the single central claim before drafting. Everything in the piece serves it.
- Write that claim as one plain sentence first. If you cannot, you are not ready to draft.
- The strongest title is that sentence itself, stated as a plain declarative ("X are scalable learners of Y"), and the opening line can simply restate it. Title, abstract, and introduction then make one claim at three zoom levels.
- Name the reader and what they must already accept for the claim to land, then write to that gap.

## Open with the thing itself

- Drop the reader into the subject with a concrete image, example, or tension that is the argument in miniature. No warm-up, no "in today's world".
- A metaphor may open a piece only if it is load-bearing: it must set up the exact distinction the piece turns on, and be cashed out in literal terms within a sentence or two.
  "If the mind is an ocean, we spend our lives floating at the surface" earns its place because surface versus depth is the paper's actual subject, and the next sentence grounds it in specifics: visual systems parsing a face, motor circuits holding posture.
- Test: if the opening could sit on top of any piece in the genre, it is decoration. Cut it.

## Structure it top down

- Use context, then content, then conclusion at every scale: the whole piece, each section, each paragraph.
- The abstract or opening is the whole argument in miniature, all three parts in a few sentences.
- Open each section with one sentence that ties it to what came before, then say what this section will add. One sentence, not a recap.
- Let questions drive the structure. State the question a section answers, then answer it. "What would it mean for a model to have a workspace?" pulls the reader forward; a heading over a pile of facts does not.
- Give each point one home. Only the central claim may recur; everything else is said once, where it belongs.

## Define before you argue

- When the piece leans on a fuzzy concept, turn it into checkable criteria before using it, then let those criteria organize the piece.
  A paper that defines "workspace-like" as five testable properties can spend a section on each; the definition becomes the outline.
- Operational definitions also discipline you: if you cannot say what evidence would count against the concept, it is a vibe, not a claim.
- To position a contribution, recast the existing approaches as variants of one abstraction, then derive from it the two or three properties a good solution needs, stated as a short numbered list.
  Prior work then lands on those axes (one approach is large but inconsistent, another consistent but small), and your proposal becomes the cell nobody fills.
- Those desiderata become the spine of the piece: each later experiment or section names which one it is testing, so no result ever floats free of the argument.
- When the core idea is natural and older than your piece, the contribution is the diagnosis. Ask in one sentence why the obvious version has not worked, enumerate the differences that block it, and let each difference generate one design decision.
  "Driven by this analysis, we present..." then reads as inevitable rather than invented.

## Answer the objection where it arises

- After each claim, ask what a skeptical reader says next. Say it in their words, then deal with it, right there. Do not save objections for a rebuttal section at the end.
- The strongest form is objection as experiment: "This does not, however, establish X; Y could produce the same result. To rule that out, we..." Claim, objection, test, in that order, is the engine of convincing research prose.
- When introducing a thesis, steelman both directions before committing: why it might be false, why it might be true, then what you found. One-sided setups read as sales copy.

## Claim discipline

- Scope every claim to exactly what the evidence supports, and say what you are not claiming at the moment a reader might over-read.
  "We do not claim the full architecture carries over" placed right after the exciting analogy is worth more than a limitations section three pages later.
- Naming the stronger claim you decline to make ("we do not feel comfortable claiming this is sufficient for monitoring") reads as strength, not weakness. It shows you know where the edge of your evidence is.
- Hedge with content. A hedge must say what exactly is uncertain, which alternatives are live, and what would resolve it: "We do not know whether this is a fact about the model or an artifact of the lens. One possibility is A; another is B; this experiment would distinguish them."
  Blanket hedges ("may potentially suggest") carry no information and just slow the sentence down; see the rewriting mode's hedging pattern.
- Spend emphasis like a budget. "Strikingly" and "surprisingly" work once or twice per piece, on findings that genuinely defy the setup you built. If everything is striking, nothing is.
- To make a surprise land, state the expectation it violates, with numbers: "the optimal ratio is 75%; the standard in language is 15%, and prior work in vision used 20% to 50%". Surprise without the prior is just an adjective.
- Adjectives you apply to your own work ("simple", "efficient", "scalable") must be cashed out in mechanics within a paragraph: name the three operations, give the speedup factor. Uncashed, they are marketing.

## Show the discovery when it explains the method

- Where a method or argument would otherwise look arbitrary, narrate how you got there: noticed, hypothesized, tested.
  "We noticed the word appears early in the readout. This led us to hypothesize... To test this, we..." makes the experiment feel inevitable instead of conjured.
- Keep it short and honest. This is motivation for the reader, not a lab diary.
- Introduce a mechanism as the repair of the obvious approach's specific failure: the naive fix, how it fails, the hypothesized cause, then your design.
  A method presented this way needs no selling, because the alternative has already lost on the page.

## Make it flow

- One paragraph, one idea, stated in its first sentence.
- In a run of parallel discussion paragraphs (limitations, related theories, design options), a bold run-in label at the head of each ("Beyond single-token concepts. ...") lets readers scan. This is a paragraph label, not the bolded bullet-list pattern the rewriting mode bans.
- Open each sentence and paragraph with what the reader already knows, and end with what is new.
- Keep the subject and verb close and near the front. Do not strand the reader waiting for the verb.
- Put the most important word at the end of the sentence, where the emphasis lands.
- Put the action in the verb. "We measured X" beats "measurements of X were performed".
- After a technical definition, restate it once as a plain, memorable description that loses no precision: "a small, evolving set of unspoken words, neither echoes of the input nor predictions of the next token". One restatement; more becomes padding.
- Repeat load-bearing terms verbatim. If "consistent" names one of the piece's key properties, it is "consistent" every time, not "stable" or "coherent". The rewriting mode's synonym-cycling pattern governs ordinary prose; terminology is the opposite case, where variation costs the reader the thread.
- After the evidence, give the verdict in one short sentence: "It is 2.6% worse." Ceremony around a verdict dilutes it.

## Research writing specifics

- Keep what the data show separate from what you think it means. Label claim, evidence, and interpretation.
- Quantify. Give the number and the effect size, not "significantly" or "substantially". "6-7% of variance" and "59% versus 88%" settle arguments that adverbs start.
- Follow every abstraction with an instance. A property gets an example, a category gets a member, a failure mode gets a concrete case. If a paragraph goes five sentences without touching a specific, it is drifting.
- Let figures carry the argument, and write captions that state the takeaway, not just the axes.
- Give each limitation its own named paragraph with three beats: the problem, its consequence for your claims, and what would resolve it. A limitation you analyze reads as confidence; a limitation you list reads as a disclaimer.
- Make comparisons attributable. State what varies and what is held fixed, and keep every choice standard except the one you are selling, so a gain has only one place to come from.
- Fight for the baseline. Tune competitors as carefully as your own method, cite their best numbers, and when your protocol favors them, say so: "this may place us at a disadvantage; even so..." is among the most convincing sentences a results section can contain.
- Put the losses in the summary next to the wins, with numbers. "Worse by 0.8 on X, a negative case we observed" buys credibility for every positive number around it, and the setting where the method breaks outright is evidence you understand it, not evidence against it.
- Show the unflattering version when it is more informative, and say that you chose to. "One could overlay the visible patches to improve visual quality; we opt not to, to demonstrate the method's behavior" turns a cosmetic weakness into evidence of candor.
- When several signals bear on one claim, report them as one story and let them check each other: "the task is harder: training loss is higher and the reconstructions are blurrier". Converging evidence in one sentence beats three disconnected observations.
- When two standard metrics disagree, the disagreement is a finding. Say it plainly ("the two protocols are largely uncorrelated"), ask what each one actually measures, and let the answer drive the next experiment, rather than averaging them or quoting the friendlier one.

## End small

- Close on what remains: the unresolved question, the negative case, the concrete next step. "The improvement from A to B is smaller than expected, suggesting the data is not fully exploited" does more for credibility than any closing flourish.
- The rewriting mode bans generic upbeat endings; this is the positive form of that rule. An ending earns its place the same way any sentence does, by carrying information.
- One sentence of zoom-out is the ceiling ("simple algorithms that scale are the core of the field"), and it works only when the piece has earned it; return to specifics immediately.

## Then clean it up

- A first draft will still have flat rhythm, AI tells, and an unfocused voice.
- Switch to `references/writing/rewriting.md` and run its draft, audit, final loop over the text.
