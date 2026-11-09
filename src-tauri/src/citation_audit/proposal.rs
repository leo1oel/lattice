//! Turning verified remote metadata and local repairs into one reviewable
//! replacement. Untouched fields keep their original expressions; only the
//! fields a verified source or a safe local cleanup changes are rewritten.
use super::*;
use std::collections::BTreeSet;

/// The fields a verified metadata source may correct; all others stay local.
const MERGED_FIELDS: [&str; 11] = [
    "title",
    "author",
    "year",
    "journal",
    "booktitle",
    "publisher",
    "volume",
    "number",
    "pages",
    "doi",
    "url",
];

// Local repairs must remain available even when a remote candidate is rejected.
// They modify the current entry, never fields from that rejected candidate.
pub(crate) fn protect_bibtex(raw: &str) -> String {
    cleanup_result(result("checked", "", raw)).after.unwrap_or_else(|| raw.into())
}

pub(super) fn merge_metadata(before: &str, remote: &str, published: bool) -> AuditResult {
    let (local, mut other) = (fields(before), fields(remote));
    // A source's venue is proposed by its canonical name, and is no change at
    // all when the entry already cites that venue in any spelling: "Advances
    // in Neural Information Processing Systems 35" restates "(NeurIPS)".
    let year = |values: &BTreeMap<String, String>| field_value(values, "year").parse().ok();
    let venue_year = year(&other).or_else(|| year(&local));
    let mut same_venue = BTreeSet::new();
    for name in ["journal", "booktitle"] {
        let Some(value) = other.get(name) else {
            continue;
        };
        if local.get(name).is_some_and(|v| same_canonical_venue(v, value, venue_year)) {
            same_venue.insert(name);
        }
        if let Some(canonical) = canonical_venue(value, venue_year) {
            other.insert(name.into(), canonical.into());
        }
    }
    let words = |value: &str| {
        value.replace(['{', '}'], "").split_whitespace().map(str::to_string).collect::<Vec<_>>()
    };
    let changed = MERGED_FIELDS
        .into_iter()
        .filter(|name| {
            let (a, b) = (field_value(&local, name), field_value(&other, name));
            let equivalent = if *name == "title" {
                // Keep local protection, but do not confuse identity matching
                // (case-insensitive) with typography: ImageNet != Imagenet.
                (a.contains('{') && normalize_title(&a) == normalize_title(&b))
                    || words(&a) == words(&b)
                    || drops_short_name(&a, &b)
            } else if *name == "url" {
                // A link to the paper's own DOI is as good as the landing page
                // a source names; the entry editor fills one in for a DOI. An
                // arXiv link (DBLP's for an ICLR paper) never replaces the
                // proceedings or publisher page an entry already links.
                same_value(name, &a, &b)
                    || normalize_doi(&a).is_some_and(|doi| entry_doi(&other) == Some(doi))
                    || (is_arxiv_url(&b) && !a.trim().is_empty() && !is_arxiv_url(&a))
            } else {
                same_venue.contains(name) || same_value(name, &a, &b)
            };
            !b.is_empty() && !equivalent
        })
        .collect::<Vec<_>>();
    let mut merged = field_expressions(before);
    if local.keys().any(|key| !merged.contains_key(key)) {
        return result(
            "unavailable",
            "Could not safely preserve this entry's BibTeX expressions.",
            before,
        );
    }
    for name in changed {
        merged.insert(name.into(), format!("{{{}}}", stored_value(name, &other[name])));
    }
    if published || entry_type(before) != entry_type(remote) {
        for name in ["journal", "booktitle"] {
            if !other.contains_key(name) {
                merged.remove(name);
            }
        }
    }
    // Mirror bibcite.clean_publication_fields after merging local expressions;
    // normalizing remote metadata alone cannot remove obsolete local fields.
    // Keep this in-process so S2 batches don't spawn one CLI per entry.
    merged.remove("primaryclass");
    let has_publication = ["journal", "booktitle"].iter().any(|name| {
        merged.get(*name).is_some_and(|value| {
            if !value.trim_start().starts_with(['{', '"']) {
                return false;
            }
            let value = clean(value).to_lowercase();
            !value.is_empty() && !is_preprint_venue(&value)
        })
    });
    if has_publication
        && merged.get("pubstate").is_none_or(|value| !clean(value).eq_ignore_ascii_case("preprint"))
        && merged.get("howpublished").is_some_and(|value| {
            let value = value.to_lowercase();
            value.contains("arxiv") || value.contains("preprint")
        })
    {
        merged.remove("howpublished");
    }
    // The remote record's explicit type is evidence. A booktitle alone is not:
    // chapters and conference papers both commonly carry one.
    let remote_type =
        remote.trim_start().trim_start_matches('@').split(['{', '(']).next().unwrap_or("article");
    // S2 sometimes emits @article with only a conference booktitle. Correct
    // that known malformed shape, but never generalize booktitle to conference
    // for explicit chapter/book types.
    let kind = if remote_type.eq_ignore_ascii_case("article")
        && other.contains_key("booktitle")
        && !other.contains_key("journal")
    {
        "inproceedings"
    } else {
        remote_type
    };
    let spans = project::bibliography_entry_spans(before);
    let key = spans.first().map(|v| v.0.as_str()).unwrap_or("citation");
    proposal(before, render_entry(kind, key, merged), "DOI metadata corrections are available.")
}

/// Local repairs that need no source: protect mixed-case title words, drop
/// repeated authors, and remove an annual venue's redundant year volume.
pub(super) fn cleanup_result(checked: AuditResult) -> AuditResult {
    if checked.status == "conflict" {
        return checked;
    }
    let source = checked.current();
    if !complete_entry(source) {
        return checked;
    }
    let values = fields(source);
    let mut expressions = field_expressions(source);
    if values.keys().any(|key| !expressions.contains_key(key)) {
        return checked;
    }
    let mut changed = false;
    if let Some(title) = values.get("title") {
        // Preserve source casing rather than guessing a dictionary of model
        // names, but brace only the words that carry it. Bracing the whole
        // title would also freeze its ordinary words against a sentence-case
        // style, which then cannot lowercase "Few-Shot Learners".
        if let Some(protected) = expressions
            .get("title")
            .filter(|raw| *raw == &format!("{{{title}}}") || *raw == &format!("\"{title}\""))
            .and_then(|_| protected_title(title))
        {
            expressions.insert("title".into(), format!("{{{protected}}}"));
            changed = true;
        }
    }
    if let Some(author) = expressions.get("author").and_then(|raw| deduplicated_authors(raw)) {
        expressions.insert("author".into(), author);
        changed = true;
    }
    // TMLR's annual index and ICLR's proceedings export use the year as a
    // volume label. Omit that redundant label, not genuine numbered volumes
    // (including NeurIPS/PMLR or other journals with year-shaped volumes).
    let venue = normalize_text(
        values.get("journal").or_else(|| values.get("booktitle")).map(String::as_str).unwrap_or(""),
    );
    let annual_venue = matches!(
        venue.as_str(),
        "tmlr"
            | "transactions on machine learning research"
            | "transactions on machine learning research (tmlr)"
            | "iclr"
            | "international conference on learning representations"
            | "international conference on learning representations (iclr)"
    );
    if annual_venue
        && values.get("year").is_some_and(|year| {
            year.len() == 4 && year.parse::<u32>().is_ok() && values.get("volume") == Some(year)
        })
    {
        expressions.remove("volume");
        changed = true;
    }
    if !changed {
        return checked;
    }
    let spans = project::bibliography_entry_spans(source);
    let Some((key, _, _)) = spans.first().filter(|_| spans.len() == 1) else {
        return checked;
    };
    let after = render_entry(&entry_type(source), key, expressions);
    let mut cleaned = proposal(&checked.before, after, "Bibliography cleanup is available. Only the proposed changes will be applied; rejected source metadata is not used.");
    cleaned.sources = checked.sources;
    cleaned.health = checked.health;
    cleaned.publication_reason = checked.publication_reason;
    cleaned.official = checked.official;
    cleaned.disagreements = checked.disagreements;
    cleaned.withheld = checked.withheld;
    // Keep an incomplete health verdict when combining with a remote update.
    if checked.after.is_some() && checked.status == "unavailable" {
        cleaned.status = checked.status;
        cleaned.message = checked.message;
    }
    cleaned
}

/// `title` with each word a style must not recase braced on its own: an
/// acronym or mixed-case name (BERT, LoRA, ImageNet, DINOv2, 3D, GPT-4), or
/// None when no such word is unprotected. Hyphenated title case ("Few-Shot")
/// is ordinary capitalisation. A word already inside braces, or carrying a
/// command or math, is the writer's own markup and stays as written.
fn protected_title(title: &str) -> Option<String> {
    let mixed_case = |word: &str| {
        word.split(['-', '/']).any(|part| part.chars().skip(1).any(char::is_uppercase))
    };
    let mut words = Vec::new();
    let (mut depth, mut escaped, mut start) = (0, false, None);
    for (index, character) in title.char_indices() {
        if !std::mem::take(&mut escaped) {
            match character {
                '\\' => escaped = true,
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            }
        }
        match (character.is_whitespace() && depth == 0, start) {
            (true, Some(from)) => {
                words.push(from..index);
                start = None;
            }
            (false, None) => start = Some(index),
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    words.extend(start.map(|from| from..title.len()));
    let mut protected = String::new();
    let mut cursor = 0;
    for word in words {
        let text = &title[word.clone()];
        let core = text.trim_matches(|c: char| !c.is_alphanumeric());
        if core.is_empty() || text.contains(['{', '}', '\\', '$']) || !mixed_case(core) {
            continue;
        }
        let at = word.start + text.find(core).unwrap();
        protected.push_str(&title[cursor..at]);
        protected.push_str(&format!("{{{core}}}"));
        cursor = at + core.len();
    }
    (cursor > 0).then(|| protected + &title[cursor..])
}

/// A title without the brace pairs that enclose all of it. Such a pair only
/// freezes the whole title's casing, so adding or removing one is not a
/// correction a source can make.
fn unwrapped_title(mut title: &str) -> &str {
    while let Some(inner) = title.trim().strip_prefix('{').and_then(|v| v.strip_suffix('}')) {
        let closes_early = brace_depths(inner).any(|(_, _, depth)| depth < 0);
        if closes_early {
            break;
        }
        title = inner;
    }
    title.trim()
}

fn deduplicated_authors(raw: &str) -> Option<String> {
    let body = raw
        .strip_prefix('{')
        .and_then(|v| v.strip_suffix('}'))
        .or_else(|| raw.strip_prefix('"').and_then(|v| v.strip_suffix('"')))?;
    let mut names = Vec::new();
    let (mut depth, mut start) = (0, 0);
    for (index, character, after) in brace_depths(body) {
        depth = after;
        if depth < 0 || (depth == 0 && character == '#') {
            return None;
        }
        if depth == 0
            && body.get(index..index + 3).is_some_and(|word| word.eq_ignore_ascii_case("and"))
            && body[..index].chars().next_back().is_some_and(char::is_whitespace)
            && body[index + 3..].chars().next().is_some_and(char::is_whitespace)
        {
            names.push(body[start..index].trim());
            start = index + 3;
        }
    }
    if depth != 0 {
        return None;
    }
    names.push(body[start..].trim());
    let mut seen = Vec::new();
    let mut kept = Vec::new();
    for name in &names {
        if name.is_empty() {
            return None;
        }
        // Preserve the order of name parts: "Li Wang" and "Wang Li" may be
        // different people. Only explicit BibTeX commas authorize reordering.
        let normalized = if !name.contains(['{', '}']) && name.matches(',').count() == 1 {
            let (family, given) = name.split_once(',').unwrap();
            normalize_text(&format!("{} {}", given.trim(), family.trim()))
        } else {
            normalize_text(name)
        };
        if !seen.contains(&normalized) {
            seen.push(normalized);
            // Unambiguous group suffixes in scholarly metadata are corporate
            // authors, not a person whose surname happens to be "Team".
            let corporate = !name.contains(['{', '}', ',', '\\'])
                && name.split_whitespace().count() > 1
                && name
                    .split_whitespace()
                    .last()
                    .is_some_and(|last| matches!(last, "Team" | "Consortium" | "Collaboration"));
            kept.push(if corporate { format!("{{{name}}}") } else { (*name).to_string() });
        }
    }
    (kept != names).then(|| format!("{{{}}}", kept.join(" and ")))
}

/// An "update" listing every changed field, or "checked" when nothing changed.
pub(super) fn proposal(before: &str, after: String, message: &str) -> AuditResult {
    let (old_values, new_values) = (fields(before), fields(&after));
    let names = old_values
        .keys()
        .chain(new_values.keys())
        .map(String::as_str)
        .chain(["ENTRYTYPE"])
        .collect::<BTreeSet<_>>();
    let changes = names
        .into_iter()
        .filter_map(|field| {
            let (old, new) = if field == "ENTRYTYPE" {
                (entry_type(before), entry_type(&after))
            } else {
                (field_value(&old_values, field), field_value(&new_values, field))
            };
            // Field order and alignment are never compared; title braces
            // are, except a pair around the whole title.
            let changed = if field == "title" {
                unwrapped_title(&old) != unwrapped_title(&new)
            } else {
                normalize_text(&old) != normalize_text(&new)
            };
            changed.then(|| FieldChange { field: field.into(), before: old, after: new })
        })
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return result("checked", "No update found.", before);
    }
    let update = result("update", message, before);
    AuditResult { after: Some(after), changes, ..update }
}

/// The identity-relevant fields that differ, shown beside a rejected candidate.
pub(super) fn differing_fields(before: &str, remote: &str) -> Vec<FieldChange> {
    let (a, b) = (fields(before), fields(remote));
    ["ENTRYTYPE", "title", "author", "year", "journal", "booktitle", "doi", "eprint"]
        .into_iter()
        .filter_map(|field| {
            let (old, new) = if field == "ENTRYTYPE" {
                (entry_type(before.trim()), entry_type(remote.trim()))
            } else {
                (field_value(&a, field), field_value(&b, field))
            };
            (!same_value(field, &old, &new)).then(|| FieldChange {
                field: field.into(),
                before: old,
                after: new,
            })
        })
        .collect()
}

/// Author lists compare as names (TeX accents and BibTeX name order aside),
/// page ranges as their two ends, DOI links as their DOI; other fields compare
/// case- and whitespace-insensitively. Typography alone (`3558-3568` against
/// `3558--3568`, `http://dx.doi.org/` against `https://doi.org/`) is never a
/// correction.
pub(super) fn same_value(field: &str, a: &str, b: &str) -> bool {
    match field {
        "author" => author_names(a) == author_names(b),
        "pages" => normalize_text(&page_range(a)) == normalize_text(&page_range(b)),
        "url" if normalize_doi(a).is_some() => normalize_doi(a) == normalize_doi(b),
        _ => normalize_text(a) == normalize_text(b),
    }
}

fn is_arxiv_url(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    ["arxiv.org/", "doi.org/10.48550/"].iter().any(|host| url.contains(host))
}

/// A page range in BibTeX's `first--last` form, whatever dash a source used.
fn page_range(value: &str) -> String {
    static RANGE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"^\s*([A-Za-z]*\d+)\s*(?:-{1,3}|\x{2013}|\x{2014}|\x{2212})\s*([A-Za-z]*\d+)\s*$",
        )
        .unwrap()
    });
    match RANGE.captures(value) {
        Some(range) => format!("{}--{}", &range[1], &range[2]),
        None => value.trim().to_string(),
    }
}

/// A remote value as this entry should store it: page ranges with BibTeX's
/// `--`, DOI links through the canonical resolver.
fn stored_value(field: &str, value: &str) -> String {
    match field {
        "pages" => page_range(value),
        "url" if normalize_doi(value).is_some() => {
            let doi = value.trim();
            let start = doi.find("10.").unwrap_or(0);
            format!("https://doi.org/{}", &doi[start..])
        }
        // Exports wrap long fields across lines ("Li, Yifan  and\n      Du").
        _ => crate::util::collapse_whitespace(value),
    }
}

pub(super) fn is_safe_local_cleanup(before: &str, after: &str) -> bool {
    // Validate against the actual local cleanup, including every field. A
    // limited display diff would miss an unrelated URL or volume replacement.
    let expected = cleanup_result(result("checked", "", before));
    expected.after.as_deref().is_some_and(|expected| {
        entry_type(expected) == entry_type(after)
            && field_expressions(expected) == field_expressions(after)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cleanup(entry: &str) -> Option<String> {
        cleanup_result(result("checked", "", entry)).after
    }

    #[test]
    fn cleanup_protects_imported_names_without_changing_identity() {
        let before = "@misc{gemma,title={LLaVA VLMs ImageNet SigLIP DINOv2 EVEv2 Microsoft COCO},author={Gemma Team and Jane Doe},year={2024}}";
        let after = cleanup(before).unwrap();
        assert_eq!(
            fields(&after)["title"],
            "{LLaVA} {VLMs} {ImageNet} {SigLIP} {DINOv2} {EVEv2} Microsoft {COCO}"
        );
        assert_eq!(fields(&after)["author"], "{Gemma Team} and Jane Doe");
        assert!(metadata_identity_matches(before, &after));
        assert!(cleanup(&after).is_none());
    }

    #[test]
    fn title_protection_braces_names_never_the_whole_title() {
        let entry = |title: &str| {
            format!("@inproceedings{{x,title={{{title}}},author={{Jane Doe}},year={{2020}}}}")
        };
        // Title case, an acronym already braced, and a fully braced title
        // are already right: bracing the whole title only freezes its case.
        for title in [
            "Language Models are Few-Shot Learners",
            "{BERT}: Pre-training of Deep Bidirectional Transformers for Language Understanding",
            "{Language Models are Few-Shot Learners}",
            "Efficient Transformers: A Survey",
            r"\textsc{NASA} data",
            "{Microsoft COCO}: Common Objects in Context",
        ] {
            assert!(cleanup(&entry(title)).is_none(), "{title}");
        }
        for (title, expected) in [
            (
                "LoRA: Low-Rank Adaptation of Large Language Models",
                "{LoRA}: Low-Rank Adaptation of Large Language Models",
            ),
            ("Scaling (GPT-4) to 3D Scenes", "Scaling ({GPT-4}) to {3D} Scenes"),
            ("ReAct: {Synergizing} Reasoning", "{ReAct}: {Synergizing} Reasoning"),
        ] {
            let after = cleanup(&entry(title)).expect(title);
            assert_eq!(fields(&after)["title"], expected);
        }
    }

    #[test]
    fn whole_title_braces_and_field_layout_are_not_changes() {
        let before = "@inproceedings{brown2020language,\n  title={Language Models are Few-Shot Learners},\n  author={Brown, Tom and Mann, Benjamin},\n  booktitle={Advances in Neural Information Processing Systems (NeurIPS)},\n  year={2020}\n}";
        let after = "@inproceedings{brown2020language,\n  year      = {2020},\n  booktitle = {Advances in Neural Information Processing Systems (NeurIPS)},\n  author    = {Brown, Tom and Mann, Benjamin},\n  title     = {{{Language Models are Few-Shot Learners}}}\n}";
        let checked = proposal(before, after.into(), "A published version is available.");
        assert_eq!(checked.status, "checked");
        assert!(checked.changes.is_empty());
        // A brace around one word is typography a source can correct.
        let named = proposal(before, before.replace("Language Models", "{Language} Models"), "");
        assert_eq!(named.changes.len(), 1);
        assert_eq!(unwrapped_title("{BERT}: Pre-training {X}"), "{BERT}: Pre-training {X}");
    }

    #[test]
    fn title_repairs_preserve_expressions_and_explicit_protection() {
        let before = "@misc{x,title={Imagenet},author={Jane Doe},year={2009}}";
        let remote = before.replace("Imagenet", "ImageNet");
        let repaired = cleanup_result(merge_metadata(before, &remote, false)).after.unwrap();
        assert_eq!(fields(&repaired)["title"], "{ImageNet}");
        let protected = before.replace("Imagenet", "{ImageNet}");
        assert!(merge_metadata(&protected, before, false).after.is_none());
        for title in ["prefix#{NASA}", "{NASA}#suffix", "{NASA} # {Data}", r"{{NASA \} data}}"] {
            let raw = format!("@misc{{x,title={title},author={{Jane Doe}},year={{2024}}}}");
            assert_eq!(protect_bibtex(&raw), raw);
        }
        let person = "@misc{x,title={A study},author={Team, Jane and {Research and Development Team}},year={2024}}";
        assert_eq!(protect_bibtex(person), person);
    }

    #[test]
    fn unchanged_publication_has_no_proposal() {
        let before = "@inproceedings{lora, title={LoRA: Low-Rank Adaptation of Large Language Models}, booktitle={ICLR}, year={2022}}";
        let checked =
            proposal(before, before.replace(", ", ",\n  "), "A published version is available.");
        assert_eq!(checked.status, "checked");
        assert!(checked.after.is_none());
        assert!(checked.changes.is_empty());
    }

    #[test]
    fn remote_type_corrects_doi_entries_without_turning_chapters_into_conferences() {
        for (before, remote, expected) in [
            (
                "@inproceedings{x, title={Paper}, author={A}, year={2024}, journal={Journal}, doi={10.1234/x}}",
                "@article{r, title={Paper}, author={A}, year={2024}, journal={Journal}, doi={10.1234/x}}",
                "@article{x,",
            ),
            (
                "@inproceedings{c, title={Chapter}, author={A}, year={2024}, booktitle={Collected Work}, doi={10.1234/c}}",
                "@incollection{r, title={Chapter}, author={A}, year={2024}, booktitle={Collected Work}, doi={10.1234/c}}",
                "@incollection{c,",
            ),
        ] {
            assert!(compare_doi_entry(before, remote).after.unwrap().starts_with(expected));
        }
    }

    #[test]
    fn cleanup_only_proposal_preserves_identifiers_and_matches_written_content() {
        let before = "@inproceedings{paper, title={Paper}, author={A}, year={2024}, booktitle={CVPR}, doi={10.1109/CVPR52733.2024.01187}, eprint={2102.08981}, archiveprefix={arXiv}, primaryclass={cs.CV}, howpublished={arXiv preprint arXiv:2102.08981}}";
        let checked = compare_doi_entry(before, before);
        assert_eq!(checked.status, "update");
        assert_eq!(checked.changes.len(), 2);
        assert!(checked
            .changes
            .iter()
            .all(|change| ["primaryclass", "howpublished"].contains(&change.field.as_str())
                && change.after.is_empty()));
        let after = checked.after.unwrap();
        for field in ["doi", "eprint", "archiveprefix"] {
            assert_eq!(fields(&after).get(field), fields(before).get(field));
        }
        let project = TestProject::with_bib(before);
        apply(&project.root, "references.bib", "paper", before, &after).unwrap();
        assert_eq!(project.read_bib(), after);
        assert_eq!(compare_doi_entry(&after, &after).status, "checked");
    }

    #[test]
    fn local_author_cleanup_is_applicable_without_accepting_a_wrong_source() {
        let before = "@book{deep,title={Deep learning},author={Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron and Bengio, Yoshua},year={2016},publisher={MIT Press},volume={1},month=jan,note={Keep {NASA}}}";
        let wrong = "@article{other,title={Deep learning},author={Yann LeCun and Yoshua Bengio and Geoffrey Hinton},year={2015},journal={Nature}}";
        let checked = cleanup_result(compare_title_entry(before, wrong));
        assert_eq!(checked.status, "update");
        assert!(checked.candidate.is_none());
        assert_eq!(checked.changes.len(), 1);
        assert_eq!(checked.changes[0].field, "author");
        let after = checked.after.unwrap();
        assert_eq!(
            fields(&after)["author"],
            "Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron"
        );
        assert!(after.starts_with("@book{deep,"));
        assert!(after.contains("month = jan"));
        assert!(after.contains("note = {Keep {NASA}}"));
        assert!(!is_safe_local_cleanup(before, &after.replace("volume = {1}", "volume = {99}")));
        assert!(!is_safe_local_cleanup(
            before,
            &after.replace("month = jan", "url = {https://example.org/wrong}, month = jan")
        ));
        let project = TestProject::with_bib(before);
        apply(&project.root, "references.bib", "deep", before, &after).unwrap();
        assert!(cleanup(&after).is_none());
        assert!(cleanup_result(result("skipped", "", before)).after.is_some());
        assert!(cleanup_result(result("conflict", "", before)).after.is_none());
    }

    #[test]
    fn author_cleanup_preserves_names_order_groups_and_expressions() {
        for (raw, expected) in [
            ("{Smith, Alice and Bob Jones AND Alice Smith}", "{Smith, Alice and Bob Jones}"),
            (
                "{{Research and Development} and Smith, Alice and {Research and Development}}",
                "{{Research and Development} and Smith, Alice}",
            ),
        ] {
            assert_eq!(deduplicated_authors(raw).as_deref(), Some(expected));
        }
        for value in [
            "{Li Wang and Wang Li}",
            "{Alice Smith and Adam Smith}",
            "{A. Smith and Alice Smith}",
            "authors # { and Bob Jones}",
            "{Alice Smith} # { and Alice Smith}",
            "{Alice Smith and}",
        ] {
            assert!(deduplicated_authors(value).is_none(), "{value}");
        }
    }

    #[test]
    fn annual_volume_cleanup_removes_existing_and_reimported_labels_only() {
        for venue in [
            "Transactions on Machine Learning Research (TMLR)",
            "International Conference on Learning Representations (ICLR)",
        ] {
            let before = format!("@article{{v,title={{Voyager}},author={{Alice Smith}},journal={{{venue}}},volume={{2024}},year={{2024}}}}");
            let checked = cleanup_result(result("checked", "", before.clone()));
            assert_eq!(checked.changes.len(), 1);
            assert_eq!(checked.changes[0].field, "volume");
            assert_eq!(checked.changes[0].after, "");
            let after = checked.after.unwrap();
            assert!(!fields(&after).contains_key("volume"));
            assert_eq!(fields(&after)["year"], "2024");
            let project = TestProject::with_bib(&before);
            apply(&project.root, "references.bib", "v", &before, &after).unwrap();
            assert!(cleanup_result(compare_title_entry(&after, &before)).after.is_none());
            assert!(cleanup(&before.replace("volume={2024}", "volume={38}")).is_none());
        }
        let unrelated = "@article{x,title={Paper},author={Alice Smith},journal={Other Journal},year={2024},volume={2024}}";
        assert!(cleanup(unrelated).is_none());
    }

    #[test]
    fn metadata_merge_keeps_key_and_custom_fields() {
        let before = "@article{mine,\n title={Old},\n author={A},\n year={2020},\n doi={10.1234/x},\n custom={keep}, month=jan, note={Keep {NASA}}, howpublished={\\url{https://example.org}}\n}";
        let remote = "@article{remote, title={Old}, author={A}, year={2021}, doi={10.1234/x}}";
        let got = compare_doi_entry(before, remote);
        let after = got.after.unwrap();
        for kept in [
            "@article{mine,",
            "custom = {keep}",
            "month = jan",
            "note = {Keep {NASA}}",
            r"howpublished = {\url{https://example.org}}",
        ] {
            assert!(after.contains(kept), "{kept} missing from {after}");
        }
        assert_eq!(got.status, "update");
    }
}
