import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * Why the academic grammar profile turns each rule off, as Settings shows it
 * beside the rule. The list itself is `ACADEMIC_OFF` in src-tauri/src/harper.rs,
 * whose tests keep the two in step: a reason per rule, and no other.
 */
export const ACADEMIC_RULE_REASONS: Readonly<Record<string, MessageDescriptor>> = {
  ExpandMemoryShorthands: msg`Papers write sizes with unit symbols such as GB and MB.`,
  ExpandMinimum: msg`In a paper “min” is usually minutes or the minimum operator.`,
  ExpandTimeShorthands: msg`Papers write durations with unit symbols such as ms and h.`,
  LongSentences: msg`Academic sentences run long by convention, and hidden citations and math make the word count unreliable.`,
  MoreAdjective: msg`It flags phrases like “most early in training”, which it says are not errors.`,
  OxfordComma: msg`The serial comma is a house-style choice that venues and authors set differently.`,
  PhrasalVerbAsCompoundNoun: msg`Technical writing uses nouns like “setup” and “rollout” on purpose.`,
  SplitWords: msg`It splits technical terms such as “softmax” and “sublayer”.`,
  ToTwoToo: msg`It reads ranges and quantities like “from easy to hard” or “sum to one” as a misspelled “too”.`,
};

