"""Export a Lattice project's annotation rounds as preference data.

Every revision round already records what preference learning needs: the
writer's note and intent on a passage, the agent's proposal and reason,
whether the writer accepted it (whole or in part) or turned it down, and
the text of each file the round touched before and after
(`.research/annotations.json`, `.research/annotation-rounds/round-N.json`).
This reads them and writes, for the passages a round decided:

- `dpo.jsonl`: TRL's conversational preference pairs. The chosen text is
  what the writer kept (their edited version of a proposal, or their own
  passage when they rejected it); the rejected text is the agent's proposal.
  A proposal accepted exactly as written makes no pair.
- `kto.jsonl`: TRL's unpaired format, for the clear decisions only: a
  proposal accepted unchanged (`true`) or rejected (`false`).
- `edits.jsonl`: (context, proposal, final, edit cost) for every decision,
  the record a fine-tuning-from-edits method needs beside the pairs.
- `hunks.jsonl`: the proposal split into word-level hunks against the
  passage, each marked kept or dropped by what the writer applied.
- `writer-turns.jsonl`: the writer's side of each exchange (note, answer to
  the agent's question, decision, final text), which is what a simulated
  writer is trained on.
- `labels.jsonl`, `manifest.json`, `datasheet.md` at every level.

Prompts follow the shipping agent's (`src/agent/agent-annotations.ts`):
the intent's task line, the note, any question and answer, then the
passage, so the data matches what the deployed agent reads.

Consent levels (`--level`), as the research-env plan defines them:
0 is labels, counts and lengths only, no text; 1 adds the passages the
agent touched, its proposals and the writer's notes, with `%` comments
removed (LaTeX comments hold discarded drafts) and emails and URLs
scrubbed; 2 adds the context around each passage with its comments and the
round's whole files. Author and project ids become salted hashes, and file
paths are hashed below level 2. Replies by anyone but an annotation's own
author are dropped: co-authors did not consent. Nothing is uploaded.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import secrets
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .verifier.diffing import edit_distance
from .verifier.latex_source import strip_comments

ANNOTATIONS = ".research/annotations.json"
LEGACY_COMMENTS = ".research/editor-comments.json"
ROUNDS = ".research/annotation-rounds"
FORMAT = "lattice-preferences/1"
# The context the shipping agent reads either side of a passage.
CONTEXT_CHARS = 1_200

INTENT_TASKS = {
    "rewrite": "Rewrite the passage as the note asks.",
    "shorten": "Shorten the passage as the note asks, keeping what it claims.",
    "clarify": "Make the passage clearer as the note asks.",
    "cite": "Support the passage with a citation as the note asks.",
    "fix": "Fix the problem the note points out, changing as little as possible.",
}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
URL = re.compile(r"https?://\S+")


@dataclass
class Exporter:
    root: Path
    level: int
    salt: str
    writer: str | None = None
    names: dict[str, str] = field(default_factory=dict)

    def pseudonym(self, value: str, kind: str) -> str:
        digest = hashlib.sha256(f"{self.salt}:{kind}:{value}".encode()).hexdigest()[:12]
        return f"{kind}-{digest}"

    def scrub(self, text: str | None) -> str | None:
        """Free text a writer typed: emails, URLs and known names replaced."""
        if text is None:
            return None
        text = EMAIL.sub("<email>", text)
        text = URL.sub("<url>", text)
        for name, alias in self.names.items():
            if len(name) >= 3:
                text = re.sub(re.escape(name), alias, text, flags=re.IGNORECASE)
        return text

    def paper_text(self, text: str | None) -> str | None:
        """Text from the paper: comments dropped and emails scrubbed below level 2."""
        if text is None or self.level >= 2:
            return text
        return EMAIL.sub("<email>", strip_comments(text))

    def path(self, path: str) -> str:
        return path if self.level >= 2 else self.pseudonym(path, "file")


def read_annotations(root: Path) -> tuple[list[dict], list[dict]]:
    path = root / ANNOTATIONS
    if path.is_file():
        data = json.loads(path.read_text("utf-8"))
        return data.get("annotations", []), data.get("rounds", [])
    legacy = root / LEGACY_COMMENTS
    if legacy.is_file():
        return json.loads(legacy.read_text("utf-8")).get("comments", []), []
    return [], []


def read_round(root: Path, number: int) -> dict[str, dict]:
    path = root / ROUNDS / f"round-{number}.json"
    if not path.is_file():
        return {}
    return {file["path"]: file for file in json.loads(path.read_text("utf-8")).get("files", [])}


def locate(text: str, quote: str, prefix: str, suffix: str) -> tuple[int, int] | None:
    """Where `quote` sits in `text`, told apart by the text around it."""
    for left, right in ((prefix, suffix), (prefix, ""), ("", suffix), ("", "")):
        needle = left + quote + right
        if needle and text.count(needle) == 1:
            start = text.index(needle) + len(left)
            return start, start + len(quote)
    return None


def between(text: str, prefix: str, suffix: str, near: int) -> tuple[int, int] | None:
    """The span between `prefix` and the next `suffix`, nearest to `near`."""
    best = None
    for match in re.finditer(re.escape(prefix), text) if prefix else [None]:
        start = match.end() if match else 0
        end = text.find(suffix, start) if suffix else len(text)
        if end < 0:
            continue
        if best is None or abs(start - near) < abs(best[0] - near):
            best = (start, end)
    return best


def context(text: str, start: int, end: int) -> tuple[str, str]:
    """The text the agent read either side of the passage, cut at line breaks."""
    before = text[max(0, start - CONTEXT_CHARS) : start]
    after = text[end : end + CONTEXT_CHARS]
    if start > CONTEXT_CHARS and "\n" in before:
        before = before[before.index("\n") + 1 :]
    if end + CONTEXT_CHARS < len(text) and "\n" in after:
        after = after[: after.rindex("\n")]
    return before, after


def words(text: str) -> list[str]:
    return re.findall(r"\s+|\w+|[^\w\s]", text)


def hunks(original: str, proposal: str, applied: str | None) -> list[dict]:
    """The proposal's word-level hunks against the passage, each kept when
    the applied text made the same change at the same place."""
    base = words(original)
    applied_changes = set()
    if applied is not None:
        matcher = difflib.SequenceMatcher(None, base, words(applied), autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag != "equal":
                applied_changes.add((i1, i2, "".join(words(applied)[j1:j2])))
    found = []
    proposed = words(proposal)
    matcher = difflib.SequenceMatcher(None, base, proposed, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        new = "".join(proposed[j1:j2])
        found.append({"old": "".join(base[i1:i2]), "new": new, "kept": (i1, i2, new) in applied_changes})
    return found


def edit_cost(proposal: str, final: str) -> tuple[int, float]:
    """Characters inserted plus deleted turning the proposal into the final
    text, and that over the two lengths together (0 = kept as proposed)."""
    distance = edit_distance(proposal, final) or 0
    total = len(proposal) + len(final)
    return distance, round(distance / total, 6) if total else 0.0


def decision(state: str, proposal: str, applied: str | None, final: str | None) -> str | None:
    if state == "rejected":
        return "reject"
    if state != "accepted":
        return None
    if applied is not None and applied != proposal:
        return "accept-partial"
    if final is not None and final != (applied if applied is not None else proposal):
        return "accept-edited"
    return "accept"


def seconds_between(start: str | None, end: str | None) -> float | None:
    try:
        return (datetime.fromisoformat(end.replace("Z", "+00:00"))
                - datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()
    except (AttributeError, ValueError):
        return None


def prompt(exporter: Exporter, record: dict) -> list[dict]:
    """The shipping agent's request for this annotation, as a user turn."""
    lines = [
        f"Revise a passage of the LaTeX paper {json.dumps(record['path'])} as its author asks in an annotation.",
        INTENT_TASKS.get(record["intent"] or "", "Revise the passage as the note asks."),
        "", "<note>", record["note"], "</note>",
    ]
    if record.get("question") and record.get("answer"):
        lines += ["", "You asked the author:", record["question"], "They answered:", record["answer"]]
    if exporter.level >= 2 and record.get("before") is not None:
        lines += ["", "<before>", record["before"], "</before>"]
    lines += ["<passage>", record["passage"], "</passage>"]
    if exporter.level >= 2 and record.get("after") is not None:
        lines += ["<after>", record["after"], "</after>"]
    return [{"role": "user", "content": "\n".join(lines)}]


def assistant(text: str) -> list[dict]:
    return [{"role": "assistant", "content": text}]


def annotation_record(exporter: Exporter, annotation: dict, rounds: dict[int, dict]) -> dict | None:
    """Everything known about one annotation's latest revision, located in
    its round's files; None when it has no revision to export."""
    revision = annotation.get("revision") or {}
    number = revision.get("round")
    if not number:
        return None
    files = read_round(exporter.root, number)
    snapshot = files.get(annotation["path"], {})
    original = revision.get("original") or ""
    before_text, after_text = snapshot.get("before"), snapshot.get("after")
    prefix, suffix = annotation.get("prefix", ""), annotation.get("suffix", "")
    span = locate(before_text, original, prefix, suffix) if before_text and original else None
    applied = annotation.get("quote") if revision.get("state") == "accepted" else None
    final, final_from = None, None
    if after_text is not None:
        near = span[0] if span else 0
        found = between(after_text, prefix, suffix, near)
        if found:
            final, final_from = after_text[found[0] : found[1]], "round-after"
    if final is None and revision.get("state") == "accepted":
        final, final_from = applied, "applied"
    if final is None and revision.get("state") == "rejected":
        final, final_from = original, "passage"
    before_context, after_context = context(before_text, *span) if span else (None, None)
    round_info = rounds.get(number, {})
    return {
        "annotation": exporter.pseudonym(annotation["id"], "annotation"),
        "author": exporter.pseudonym(annotation.get("authorId", ""), "writer"),
        "path": exporter.path(annotation["path"]),
        "round": number,
        "state": revision.get("state"),
        "intent": annotation.get("intent"),
        "note": exporter.scrub(annotation.get("body", "")),
        "passage": exporter.paper_text(original),
        "proposal": exporter.paper_text(revision.get("text")),
        "reason": exporter.scrub(revision.get("reason")),
        "question": exporter.scrub(revision.get("question")),
        "answer": exporter.scrub(revision.get("answer")),
        "applied": exporter.paper_text(applied),
        "final": exporter.paper_text(final),
        "finalFrom": final_from,
        "before": before_context,
        "after": after_context,
        "roundSeconds": seconds_between(round_info.get("startedAt"), round_info.get("settledAt")),
        "replies": [exporter.scrub(reply.get("body")) for reply in annotation.get("replies", [])
                    if reply.get("authorId") == annotation.get("authorId")],
    }


def export(root: Path, out: Path, level: int = 1, salt: str | None = None, writer: str | None = None) -> dict:
    if level not in (0, 1, 2):
        raise ValueError("The consent level is 0, 1 or 2.")
    annotations, rounds = read_annotations(root)
    exporter = Exporter(root, level, salt or secrets.token_hex(16), writer)
    for annotation in annotations:
        for person in (annotation, *annotation.get("replies", [])):
            if person.get("authorName"):
                exporter.names[person["authorName"]] = exporter.pseudonym(person.get("authorId", ""), "writer")
    rounds_by_number = {r["number"]: r for r in rounds if "number" in r}
    if writer is not None:
        annotations = [a for a in annotations if a.get("authorId") == writer]
    records = [r for r in (annotation_record(exporter, a, rounds_by_number) for a in annotations) if r]
    rows: dict[str, list[dict]] = {name: [] for name in ("labels", "dpo", "kto", "edits", "hunks", "writer-turns")}
    for record in records:
        add_rows(exporter, record, rows)
    # Earlier rounds keep only their outcome per annotation (a retried
    # proposal's text is replaced by the next one): labels, no text.
    latest = {(r["annotation"], r["round"]) for r in records}
    kept = {annotation["id"] for annotation in annotations}
    for round_record in rounds:
        for annotation_id, state in sorted(round_record.get("outcomes", {}).items()):
            key = (exporter.pseudonym(annotation_id, "annotation"), round_record.get("number"))
            if annotation_id in kept and key not in latest:
                label = {"accepted": "accept", "rejected": "reject"}.get(state, state)
                rows["labels"].append({"annotation": key[0], "round": key[1], "decision": label, "text": False})
    out.mkdir(parents=True, exist_ok=True)
    written = {}
    for name, lines in rows.items():
        if level == 0 and name != "labels":
            continue
        (out / f"{name}.jsonl").write_text("".join(json.dumps(line, ensure_ascii=False) + "\n" for line in lines), "utf-8")
        written[name] = len(lines)
    if level >= 2:
        write_rounds(exporter, rounds, out)
        written["rounds"] = len(rounds)
    manifest = {
        "format": FORMAT,
        "level": level,
        "project": exporter.pseudonym(str(root.resolve()), "project"),
        "annotations": len(annotations),
        "files": written,
        "decisions": dict(sorted(Counter(r["decision"] for r in rows["labels"] if r.get("decision")).items())),
        "intents": dict(sorted(Counter(r["intent"] or "none" for r in records).items())),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", "utf-8")
    (out / "datasheet.md").write_text(datasheet(manifest), "utf-8")
    return manifest


def add_rows(exporter: Exporter, record: dict, rows: dict[str, list[dict]]) -> None:
    proposal, final, passage = record["proposal"], record["final"], record["passage"]
    decided = decision(record["state"], proposal or "", record["applied"], final) if proposal is not None else None
    cost = edit_cost(proposal, final) if decided and final is not None else (None, None)
    split = hunks(passage or "", proposal or "", record["applied"] if decided != "reject" else passage) if decided else []
    meta = {"annotation": record["annotation"], "round": record["round"], "intent": record["intent"],
            "decision": decided, "author": record["author"]}
    rows["labels"].append({
        **meta, "state": record["state"], "text": exporter.level >= 1,
        "passageChars": len(passage or ""), "proposalChars": len(proposal or ""), "finalChars": len(final or ""),
        "editChars": cost[0], "editCost": cost[1], "roundSeconds": record["roundSeconds"],
        "hunksKept": sum(h["kept"] for h in split), "hunksDropped": sum(not h["kept"] for h in split),
    })
    rows["writer-turns"].append({
        **meta, "path": record["path"], "note": record["note"], "agentQuestion": record["question"],
        "writerAnswer": record["answer"], "replies": record["replies"], "passage": passage,
        "proposal": proposal, "final": final, "before": record["before"] if exporter.level >= 2 else None,
        "after": record["after"] if exporter.level >= 2 else None,
    })
    if not decided:
        return
    user = prompt(exporter, record)
    rows["edits"].append({**meta, "prompt": user, "proposal": proposal, "reason": record["reason"],
                          "final": final, "finalFrom": record["finalFrom"], "editChars": cost[0], "editCost": cost[1]})
    rows["hunks"].append({**meta, "passage": passage, "hunks": split})
    if decided in ("accept", "reject"):
        rows["kto"].append({"prompt": user, "completion": assistant(proposal), "label": decided == "accept", "meta": meta})
    if decided != "accept" and final is not None and final != proposal:
        rows["dpo"].append({"prompt": user, "chosen": assistant(final), "rejected": assistant(proposal),
                            "meta": {**meta, "chosenFrom": "kept-passage" if decided == "reject" else "writer-final"}})


def write_rounds(exporter: Exporter, rounds: list[dict], out: Path) -> None:
    with (out / "rounds.jsonl").open("w", encoding="utf-8") as handle:
        for round_record in rounds:
            files = read_round(exporter.root, round_record["number"])
            handle.write(json.dumps({
                "round": round_record["number"],
                "outcomes": {exporter.pseudonym(k, "annotation"): v for k, v in round_record.get("outcomes", {}).items()},
                "files": [{"path": f["path"], "before": f.get("before"), "after": f.get("after")} for f in files.values()],
            }, ensure_ascii=False) + "\n")


def datasheet(manifest: dict) -> str:
    """A datasheet (Gebru et al.) to ship with every export."""
    level = manifest["level"]
    text = {0: "labels, counts and lengths only; no text",
            1: "the passages the agent revised, its proposals and reasons, and the writer's notes and answers; "
               "LaTeX `%` comments removed, emails and URLs scrubbed",
            2: "level 1 plus the context around each passage with its comments, and each round's whole files"}[level]
    files = "\n".join(f"| `{name}.jsonl` | {count} |" for name, count in manifest["files"].items())
    return f"""# Datasheet: Lattice annotation-round preferences

Format `{manifest['format']}`, consent level {level}: {text}.

## Motivation
Preference and edit data from a writer revising their own LaTeX paper with an AI agent in Lattice, for
training and evaluating revision agents (DPO, KTO, learning from edits) and simulated writers.

## Composition
One project ({manifest['project']}), {manifest['annotations']} annotations.
Decisions: {json.dumps(manifest['decisions'])}. Intents: {json.dumps(manifest['intents'])}.

| File | Rows |
| --- | --- |
{files}

Each decided proposal is labelled `accept` (applied as proposed), `accept-partial` (some of its hunks
applied), `accept-edited` (applied, then changed by the writer before the round settled) or `reject`.
The final text is read from the round's saved files where the passage can be located, otherwise from
what the writer applied. Earlier rounds of a retried annotation keep their outcome but not their text.

## Collection
Recorded by Lattice as the writer used annotation rounds; nothing was collected beyond what the app
keeps in the project's `.research/` folder. No keystrokes, timings beyond round start and end, or
text outside the touched files. Studies with recruited writers need IRB approval and consent recorded
outside this export.

## Preprocessing
Author, annotation and project ids are salted hashes (the salt is not exported), and file paths are
hashed below level 2. Known author names, emails and URLs are scrubbed from free text. Replies by
anyone other than an annotation's author are dropped, since co-authors did not consent.

## Uses and distribution
For research under the consent the writer gave. Do not redistribute beyond it. The text is unpublished
research: check for an embargo before any release.
"""
