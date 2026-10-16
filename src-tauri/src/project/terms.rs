//! Project terms: the names and spellings a paper settles on, and the English
//! it is written in, kept in the manifest; and the one write the Terms panel
//! makes to the paper, the changes the writer confirmed.
//!
//! Finding where a rule applies happens in the frontend
//! (`src/project/term-check.ts`), which reads LaTeX the way Proofread does;
//! this side only stores the rules and lands confirmed changes.

use super::history::apply_transaction;
use super::manifest::{read_manifest, write_manifest};
use super::paths::safe_path;
use crate::models::{ProjectManifest, TermRule, TermSkip};
use crate::util::err;
use serde::Deserialize;
use std::fs;
use std::path::Path;

/// The English variants spell checking knows (harper.rs maps them).
pub const ENGLISH_VARIANTS: [&str; 4] = ["american", "british", "canadian", "australian"];

const MAX_RULES: usize = 200;
const MAX_TERM_CHARS: usize = 120;
const MAX_VARIANTS: usize = 20;
const MAX_NOTE_CHARS: usize = 400;
const MAX_SKIPS: usize = 500;
const MAX_CONTEXT_CHARS: usize = 400;

/// Replace the project's terms and English variant. Each form is trimmed; a
/// rule keeps the first of forms equal ignoring case, and a later rule for a
/// term an earlier one already settles is dropped, as is a later variant an
/// earlier rule already settles, so the check never asks for two spellings
/// of one word.
pub fn set_terms(
    root: &Path, rules: Vec<TermRule>, english_variant: Option<String>,
) -> Result<ProjectManifest, String> {
    let english_variant = match english_variant.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(variant) if ENGLISH_VARIANTS.contains(&variant) => Some(variant.to_string()),
        Some(variant) => return Err(format!("Unknown English variant “{variant}”.")),
    };
    if rules.len() > MAX_RULES {
        return Err(format!("A project keeps at most {MAX_RULES} term rules."));
    }
    let mut normalized: Vec<TermRule> = Vec::new();
    for rule in rules {
        let term = rule.term.trim().to_string();
        if term.is_empty() {
            continue;
        }
        if term.chars().count() > MAX_TERM_CHARS {
            return Err(format!("A term is at most {MAX_TERM_CHARS} characters."));
        }
        let settled = |form: &str| {
            normalized.iter().any(|earlier| {
                earlier.term.to_lowercase() == form.to_lowercase()
                    || earlier
                        .variants
                        .iter()
                        .any(|variant| variant.to_lowercase() == form.to_lowercase())
            })
        };
        if settled(&term) {
            continue;
        }
        let mut variants: Vec<String> = Vec::new();
        for variant in rule.variants.iter().map(|variant| variant.trim()) {
            if variant.is_empty()
                || variant.to_lowercase() == term.to_lowercase()
                || settled(variant)
            {
                continue;
            }
            if variant.chars().count() > MAX_TERM_CHARS {
                return Err(format!("A term is at most {MAX_TERM_CHARS} characters."));
            }
            if !variants.iter().any(|existing| existing.to_lowercase() == variant.to_lowercase()) {
                variants.push(variant.to_string());
            }
        }
        variants.truncate(MAX_VARIANTS);
        let mut skipped: Vec<TermSkip> = Vec::new();
        for skip in rule.skipped {
            let fits = !skip.path.is_empty() && skip.context.chars().count() <= MAX_CONTEXT_CHARS;
            if fits && !skipped.contains(&skip) {
                skipped.push(skip);
            }
        }
        // The newest skips matter most: an old one may no longer match anything.
        if skipped.len() > MAX_SKIPS {
            skipped.drain(..skipped.len() - MAX_SKIPS);
        }
        let note = rule.note.trim().chars().take(MAX_NOTE_CHARS).collect();
        normalized.push(TermRule { term, variants, note, skipped });
    }
    let mut manifest = read_manifest(root)?;
    manifest.term_rules = normalized;
    manifest.english_variant = english_variant;
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

/// One file as the check read it and as the confirmed changes leave it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermFileEdit {
    pub path: String,
    pub before: String,
    pub after: String,
}

/// Land the confirmed changes as one history entry, so one revert undoes
/// them. A file that changed on disk since the check read it is refused
/// whole: its offsets no longer say where the forms are.
pub fn apply_term_edits(
    root: &Path, label: &str, files: Vec<TermFileEdit>,
) -> Result<Vec<String>, String> {
    let mut edits = Vec::new();
    for file in files {
        if file.before == file.after {
            continue;
        }
        let current = fs::read_to_string(safe_path(root, &file.path)?).map_err(err)?;
        if current != file.before {
            return Err(format!("{} changed since the check. Check again.", file.path));
        }
        edits.push((file.path, file.after));
    }
    if edits.is_empty() {
        return Ok(Vec::new());
    }
    let changed = edits.iter().map(|(path, _)| path.clone()).collect();
    apply_transaction(root, label, edits)?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    fn rule(term: &str, variants: &[&str]) -> TermRule {
        TermRule {
            term: term.to_string(),
            variants: variants.iter().map(|variant| variant.to_string()).collect(),
            note: String::new(),
            skipped: Vec::new(),
        }
    }

    #[test]
    fn terms_are_trimmed_deduplicated_and_kept_in_the_manifest() {
        let fixture = Fixture::project("terms-normalize");
        let root = &fixture.root;
        let rules = vec![
            rule(" zero-shot ", &["zero shot", "Zero Shot", "zero-shot", " "]),
            // Already settled by the first rule: a second spelling of the same word.
            rule("zero shot", &[]),
            rule("ResNet", &[]),
            // A variant another rule settles would ask for that rule's term back.
            rule("zeroshot", &["Zero-Shot", "zero_shot"]),
            rule("ResNets", &["resnet"]),
            rule("", &["dropped"]),
        ];
        let manifest = set_terms(root, rules, Some("british".to_string())).unwrap();
        assert_eq!(manifest.english_variant.as_deref(), Some("british"));
        assert_eq!(
            manifest.term_rules,
            vec![
                rule("zero-shot", &["zero shot"]),
                rule("ResNet", &[]),
                rule("zeroshot", &["zero_shot"]),
                rule("ResNets", &[]),
            ]
        );
        let reread = read_manifest(root).unwrap();
        assert_eq!(reread.term_rules, manifest.term_rules);

        assert!(set_terms(root, Vec::new(), Some("klingon".to_string())).is_err());
        let cleared = set_terms(root, Vec::new(), None).unwrap();
        assert!(cleared.term_rules.is_empty() && cleared.english_variant.is_none());
        let written = fs::read_to_string(fixture.path(".research/project.json")).unwrap();
        assert!(!written.contains("termRules") && !written.contains("englishVariant"), "{written}");
    }

    #[test]
    fn confirmed_edits_land_together_and_a_stale_file_refuses_all() {
        let fixture = Fixture::project("terms-apply");
        let root = &fixture.root;
        fixture.write("a.tex", "zero shot one\n");
        fixture.write("b.tex", "zero shot two\n");
        let edit = |path: &str, before: &str, after: &str| TermFileEdit {
            path: path.to_string(),
            before: before.to_string(),
            after: after.to_string(),
        };

        let stale = vec![
            edit("a.tex", "zero shot one\n", "zero-shot one\n"),
            edit("b.tex", "something else\n", "zero-shot two\n"),
        ];
        assert!(apply_term_edits(root, "Use “zero-shot”", stale).unwrap_err().contains("b.tex"));
        assert_eq!(fixture.read("a.tex"), "zero shot one\n");

        let fresh = vec![
            edit("a.tex", "zero shot one\n", "zero-shot one\n"),
            edit("b.tex", "zero shot two\n", "zero-shot two\n"),
        ];
        assert_eq!(
            apply_term_edits(root, "Use “zero-shot”", fresh).unwrap(),
            vec!["a.tex", "b.tex"]
        );
        assert_eq!(fixture.read("a.tex"), "zero-shot one\n");
        assert_eq!(fixture.read("b.tex"), "zero-shot two\n");
        assert!(apply_term_edits(root, "nothing", Vec::new()).unwrap().is_empty());
    }
}
