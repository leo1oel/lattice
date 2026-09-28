//! The offline half of an audit: parse every registered bibliography and
//! report malformed entries, schema gaps and cross-file duplicates.
use super::*;
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

/// BibTeX and BibLaTeX entry types. The BibLaTeX core and standard-style
/// types after `www` have no `REQUIRED_FIELDS` row: their schemas are
/// intentionally not guessed when requirements vary by style.
const SUPPORTED_TYPES: &str = "article book booklet conference inbook incollection \
    inproceedings manual mastersthesis misc phdthesis proceedings techreport unpublished \
    collection electronic mvbook mvcollection mvproceedings online patent periodical reference \
    report suppbook suppcollection suppperiodical thesis www artwork audio bibnote commentary \
    customa customb customc customd custome customf dataset entryset image jurisdiction legal \
    legislation letter movie music performance review set software standard video xdata";

/// Required fields by entry type, in reporting order; "a or b" accepts either.
/// BibTeX deliberately defines no required fields for misc.
const REQUIRED_FIELDS: &[(&[&str], &[&str])] = &[
    (&["article"], &["author", "title", "journal", "year or date"]),
    (
        &["book", "mvbook", "reference", "suppbook"],
        &["author or editor", "title", "publisher", "year or date"],
    ),
    (&["inproceedings", "conference"], &["author", "title", "booktitle", "year or date"]),
    (
        &["incollection", "suppcollection"],
        &["author", "title", "booktitle", "publisher", "year or date"],
    ),
    (&["inbook"], &["author or editor", "title", "chapter or pages", "publisher", "year or date"]),
    (&["mastersthesis", "phdthesis"], &["author", "title", "school", "year or date"]),
    (&["thesis", "techreport", "report"], &["author", "title", "institution", "year or date"]),
    (&["proceedings", "collection", "mvcollection", "mvproceedings"], &["title", "year or date"]),
    (&["unpublished"], &["author", "title", "note"]),
    (&["online", "electronic", "www"], &["author or editor", "title", "url", "year or date"]),
    (&["booklet", "manual", "periodical", "suppperiodical"], &["title"]),
    (&["patent"], &["author or editor", "title", "number", "year or date"]),
];

pub fn scan(root: &Path) -> Result<AuditScan, String> {
    let mut entries = Vec::new();
    let mut issues = Vec::new();
    // Citation key, DOI and title identities, each to every (path, key) using it.
    let mut groups: [HashMap<String, Vec<(String, String)>>; 3] = Default::default();
    for (path, source) in audit_sources(root)? {
        if has_conflict_markers(&source) {
            issues.push(AuditIssue { path, key: None, message: UNRESOLVED_CONFLICT.into() });
            continue;
        }
        let spans = project::bibliography_entry_spans(&source);
        let unparsed = bibliography_construct_count(&source).saturating_sub(spans.len());
        if unparsed > 0 {
            let message = format!("Could not parse {unparsed} bibliography construct(s).");
            issues.push(AuditIssue { path: path.clone(), key: None, message });
        }
        for (key, start, end) in spans {
            let bibtex = source[start..end].to_string();
            let issue = |message: String| AuditIssue {
                path: path.clone(),
                key: Some(key.clone()),
                message,
            };
            if !complete_entry(&bibtex) {
                issues.push(issue("Unclosed bibliography entry; online check skipped.".into()));
                continue;
            }
            let values = fields(&bibtex);
            let title = field_value(&values, "title");
            let local = local_validation(&bibtex);
            issues.extend(local.iter().cloned().map(issue));
            let identities = [
                Some(key.to_ascii_lowercase()),
                values.get("doi").and_then(|v| normalize_doi(v)),
                (!title.is_empty()).then(|| normalize_title(&title)),
            ];
            for (group, identity) in groups.iter_mut().zip(identities) {
                if let Some(identity) = identity {
                    group.entry(identity).or_default().push((path.clone(), key.clone()));
                }
            }
            entries.push(AuditEntry { path: path.clone(), key, title, bibtex, issues: local });
        }
    }
    for (kind, group) in ["citation key", "DOI", "title"].into_iter().zip(groups) {
        for (path, key) in group.into_values().filter(|members| members.len() > 1).flatten() {
            let message = format!("Duplicate {kind} across bibliography files.");
            issues.push(AuditIssue { path, key: Some(key), message });
        }
    }
    Ok(AuditScan { entries, issues })
}

fn local_validation(entry: &str) -> Vec<String> {
    let kind = entry_type(entry);
    let values = fields(entry);
    let mut issues = Vec::new();
    if !SUPPORTED_TYPES.split_whitespace().any(|known| known == kind) {
        issues.push(format!("Unknown bibliography entry type `{kind}`."));
    }
    for (name, value) in &values {
        if value.trim().is_empty() {
            issues.push(format!("Empty {name} field."));
        }
    }
    if values.get("author").is_some_and(|value| has_repeated_authors(&author_names(value))) {
        issues.push("Repeated author names; verify against the publication's author list before removing duplicates.".into());
    }

    // A cross-referenced child may inherit every type-required field. Without
    // resolving the parent bibliography, reporting those fields as absent is
    // misleading; checks on fields explicitly present still apply.
    let inherits = ["crossref", "xref", "xdata"]
        .into_iter()
        .find_map(|name| values.get(name))
        .is_some_and(|value| !value.trim().is_empty());
    let present = |name: &str| values.get(name).is_some_and(|v| !v.trim().is_empty());
    let required = REQUIRED_FIELDS
        .iter()
        .find(|(types, _)| types.contains(&kind.as_str()))
        .map_or(&[][..], |row| row.1);
    for requirement in required.iter().filter(|_| !inherits) {
        // BibLaTeX's journaltitle stands in for journal.
        if !requirement.split(" or ").any(present)
            && !(*requirement == "journal" && present("journaltitle"))
        {
            issues.push(format!("Missing {requirement} field for {kind} entry."));
        }
    }

    if kind == "article"
        && !values.contains_key("journal")
        && !values.contains_key("journaltitle")
        && values.contains_key("booktitle")
    {
        issues.push("Article entry uses booktitle instead of journal.".into());
    }
    if matches!(kind.as_str(), "inproceedings" | "conference")
        && !values.contains_key("booktitle")
        && (values.contains_key("journal") || values.contains_key("journaltitle"))
    {
        let label = if kind == "conference" { "Conference" } else { "Inproceedings" };
        issues.push(format!("{label} entry uses journal instead of booktitle."));
    }

    if let Some(year) = field_expressions(entry).get("year") {
        let expression = year.trim();
        let value = values.get("year").map(String::as_str).unwrap_or("");
        let literal = expression == format!("{{{value}}}")
            || expression == format!("\"{value}\"")
            || expression.chars().all(|character| character.is_ascii_digit());
        let value = value.trim();
        if literal
            && !value.is_empty()
            && (value.len() != 4 || !value.chars().all(|character| character.is_ascii_digit()))
        {
            issues.push("Invalid literal year; expected four digits.".into());
        }
    }
    issues
}

/// Entry-shaped `@type{` / `@type(` constructs, excluding @comment,
/// @preamble and @string, to detect entries the span parser skipped.
fn bibliography_construct_count(source: &str) -> usize {
    static CONSTRUCT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"@([A-Za-z]*)[\t\n\x0C\r ]*[{(]").unwrap());
    let excluded = |kind: &str| matches!(kind, "comment" | "preamble" | "string");
    CONSTRUCT
        .captures_iter(source)
        .filter(|found| !excluded(&found[1].to_ascii_lowercase()))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assert that `entry` reports every one of `expected`.
    fn assert_reports(entry: &str, expected: &[&str]) {
        let issues = local_validation(entry);
        for issue in expected {
            assert!(issues.iter().any(|found| found == issue), "{entry}: {issue} in {issues:?}");
        }
    }

    #[test]
    fn scan_covers_all_files_and_reports_cross_file_duplicates_and_malformed_input() {
        let project = TestProject::with_bib(
            "@article{same, title={One}, author={A}, year={2020}, doi={10.1234/x}}\n@broken{",
        );
        fs::write(
            project.root.join("other.bib"),
            "@article{same, title={One}, author={B}, year={2021}, doi={10.1234/x}}",
        )
        .unwrap();
        let audit = scan(&project.root).unwrap();
        assert_eq!(audit.entries.len(), 2);
        let count = |text: &str| audit.issues.iter().filter(|i| i.message.contains(text)).count();
        assert!(count("Could not parse") > 0);
        assert!(count("Duplicate citation key") >= 2);
        assert!(count("Duplicate DOI") >= 2);
    }

    #[test]
    fn local_validation_applies_type_specific_bibtex_rules() {
        assert_reports("@misc{x, year={20#24}}", &["Invalid literal year; expected four digits."]);
        assert_reports("@misc{x, year={ bad }}", &["Invalid literal year; expected four digits."]);
        assert_reports(
            "@article{paper, title={}, author={Ada}, year={twenty twenty}, booktitle={Proceedings}}",
            &[
                "Empty title field.",
                "Missing journal field for article entry.",
                "Article entry uses booktitle instead of journal.",
                "Invalid literal year; expected four digits.",
            ],
        );
        assert_reports(
            "@inproceedings{paper, title={T}, author={A}, year={2024}, journal={J}}",
            &[
                "Missing booktitle field for inproceedings entry.",
                "Inproceedings entry uses journal instead of booktitle.",
            ],
        );
        assert_reports(
            "@article{a, editor={E}, title={T}, journal={J}, year={2024}}",
            &["Missing author field for article entry."],
        );
        assert_reports(
            "@madeup{x, title={T}, author={A}, year={2024}}",
            &["Unknown bibliography entry type `madeup`."],
        );
    }

    /// Standard and biblatex entry types, crossref inheritance and string
    /// expressions are not false positives.
    #[test]
    fn local_validation_accepts_biblatex_types_inheritance_and_expressions() {
        for valid in [
            "@Article {a, author={A}, title={T}, journaltitle={J}, date={2024-05}}",
            "@book{b, editor={E}, title={T}, publisher={P}, year={2024}}",
            "@online{o, author={A}, title={T}, date={2024-05}, url={https://example.test}}",
            "@incollection{x, crossref={parent}, pages={1--2}}",
            "@misc{x, year={20} # {24}}",
            "@misc{x, year={ 2024 }}",
            "@article{x, title=titlemacro # { suffix}, author=authorsmacro, year=yearmacro, journal=jmacro}",
        ] {
            assert!(local_validation(valid).is_empty(), "{valid}");
        }
    }

    #[test]
    fn repeated_authors_are_reported_and_not_imported_from_sources() {
        let before = "@article{mine,title={Example},author={Alice Smith and Bob Jones},year={2024},journal={Journal},doi={10.1234/exact}}";
        let repeated = before
            .replace("Alice Smith and Bob Jones", "Alice Smith and Bob Jones and Smith, Alice");
        let repeats = |entry: &str| {
            local_validation(entry).iter().any(|issue| issue.contains("Repeated author"))
        };
        assert!(repeats(&repeated));
        assert!(!repeats(before));
        assert!(!repeats(&before.replace("Bob Jones", "Adam Smith")));
        assert!(compare_doi_entry(before, &repeated).after.is_none());
        assert!(compare_doi_entry(&repeated, before).after.is_none());
        assert!(cleanup_result(result("checked", "", repeated)).after.is_some());
    }
}
