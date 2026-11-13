#[cfg(unix)]
use super::super::bundle::PaperMetadata;
use super::*;
#[cfg(unix)]
use crate::commands;
use crate::papers::library::{list_papers, read_paper, read_paper_blog_local};
use crate::papers::test_support::TestProject;
#[cfg(unix)]
use crate::papers::test_support::{fake_bibcite, tool_lock, write_test_tool, ToolOverride};

fn import(root: &Path, input: &str) -> Result<ImportResult, String> {
    import_reference(
        root,
        input,
        HistoryMode::Record,
        FullText::Save,
        &|_| {},
        &AtomicBool::new(false),
    )
}

#[test]
fn title_imports_prefer_a_resolved_arxiv_id_but_other_queries_fall_back() {
    let title = "A Single Transformer for Scalable Vision-Language Modeling";
    let resolved = bibcite_query_for_input(title, &|query| {
        assert_eq!(query, title);
        Ok(Some("2407.06438v3".to_string()))
    });
    assert_eq!(resolved, "https://arxiv.org/abs/2407.06438");
    assert_eq!(bibcite_query_for_input(title, &|_| Err("offline".to_string())), title);
    // URLs go straight to bibcite, and direct (also legacy) arXiv ids take
    // the URL shape its resolver recognizes, all without a title search.
    for (query, expected) in [
        (
            "https://openreview.net/forum?id=nuzFG0Rbhy",
            "https://openreview.net/forum?id=nuzFG0Rbhy",
        ),
        ("2609.01607", "https://arxiv.org/abs/2609.01607"),
        ("cs/9901002v1", "https://arxiv.org/abs/cs/9901002v1"),
    ] {
        let resolved =
            bibcite_query_for_input(query, &|_| panic!("{query} ran the title resolver"));
        assert_eq!(resolved, expected);
    }
}

#[test]
fn duplicate_arxiv_detection_uses_canonical_identity_only() {
    let bibliography = concat!(
        "@article{existingKey, title={Exact paper}, eprint={2609.01147v2}}\n",
        "@article{sameTitle, title={A tempting title match}}\n",
    );
    assert_eq!(
        existing_explicit_arxiv_citation(bibliography, "https://arxiv.org/pdf/2609.01147v5"),
        Some(("2609.01147".to_string(), "existingKey".to_string(), "Exact paper".to_string()))
    );
    for query in [
        "2609.01148",
        "A tempting title match",
        "https://example.org/2609.01147",
        "A study of 2609.01147",
    ] {
        assert_eq!(existing_explicit_arxiv_citation(bibliography, query), None, "{query}");
    }
}

/// Existing entries are kept byte for byte. An incoming record joins one
/// only with the same full title and ordered authors plus the same year or
/// identifier (a DOI URL counts); otherwise it is added under its own key,
/// and a shared identifier with conflicting metadata needs review.
#[test]
fn merging_joins_only_the_same_work_and_never_rewrites_existing_entries() {
    let shared = "@misc{old,title={A Shared Title},author={Alice Smith and Bob Jones},year={2025}}";
    let incoming = shared.replace("{old,", "{new,");
    let ids = "@misc{old,title={Shared Title},author={Alice Smith},year={2025},eprint={2510.14979},doi={10.1234/a}}";
    let doi_url = "@article{old,title={Shared Title},author={Alice Smith},year={2025},url={https://doi.org/10.1234/a}}";
    let doi = "@article{new,title={Shared Title},author={Alice Smith},year={2025},doi={10.1234/a}}";
    let other_ids = ids.replace("{old,", "{new,").replace("2510.14979", "2605.28820");
    let mut cases = vec![
        (shared, incoming.clone(), true),
        (doi_url, doi.to_string(), true),
        (doi_url, doi.replace("10.1234/a", "10.1234/b"), false),
        (ids, other_ids.replace("10.1234/a", "10.1234/b"), false),
    ];
    for changed in [
        incoming.replace("Shared", "Similar"),
        incoming.replace("Alice", "Ann"),
        incoming.replace("Bob Jones", "Carol Doe"),
        incoming.replace("Alice Smith and Bob Jones", "Bob Jones and Alice Smith"),
        incoming.replace("Alice Smith and Bob Jones", "Alice Smith and others"),
        incoming.replace("2025", "2024"),
    ] {
        cases.push((shared, changed, false));
    }
    for (before, raw, joined) in cases {
        let (merged, key, exists) = merge_resolved_citation(before, &raw, "new").unwrap();
        assert_eq!(exists, joined, "{raw}");
        if joined {
            assert_eq!((merged.as_str(), key.as_str()), (before, "old"));
        } else {
            assert_eq!(key, "new");
            assert!(merged.starts_with(before));
            assert_eq!(project::parse_bibliography(&merged).len(), 2);
        }
    }
    for (before, raw) in [
        (ids.to_string(), ids.replace("{old,", "{new,").replace("Alice", "Bob")),
        (doi_url.to_string(), doi.replace("Alice", "Bob")),
        (doi_url.replace("Shared Title", ""), doi.to_string()),
    ] {
        assert!(merge_resolved_citation(&before, &raw, "new").is_err(), "{before}\n{raw}");
    }
    // A new work whose key is taken gets a suffixed one.
    let different = shared.replace("Shared", "Different");
    assert_eq!(merge_resolved_citation(shared, &different, "old").unwrap().1, "old-2");
    assert!(crate::citation_audit::metadata_identity_matches(doi_url, doi));
    let other_doi = doi.replace("10.1234/a", "10.1234/b");
    assert!(!crate::citation_audit::metadata_identity_matches(doi_url, &other_doi));
}

/// Issue #772: a Zotero entry with a lone `"` inside a braced value hid
/// every later entry, so imports could not find their own new key and
/// duplicates of later entries were added again.
const ZOTERO_QUOTE: &str = concat!(
    "@article{possibility2024,\n",
    "  shorttitle = {Review for \"{{The Possibility Space Concept}} in {{Neuroscience}}},\n",
    "}\n",
);

#[test]
fn entries_after_a_quote_inside_braces_still_count_for_duplicates() {
    let later = "@misc{old,title={A Shared Title},author={Alice Smith},year={2025}}\n";
    let before = format!("{ZOTERO_QUOTE}{later}");
    let (merged, key, exists) =
        merge_resolved_citation(&before, &later.replace("{old,", "{new,"), "new").unwrap();
    assert_eq!((merged.as_str(), key.as_str(), exists), (before.as_str(), "old", true));
    let other = later.replace("{old,", "{new,").replace("Shared", "Different");
    let (merged, key, exists) = merge_resolved_citation(&before, &other, "new").unwrap();
    assert_eq!((key.as_str(), exists), ("new", false));
    assert_eq!(project::parse_bibliography(&merged).len(), 3);
}

#[cfg(unix)]
#[test]
fn an_import_after_a_quote_inside_braces_finds_its_new_key() {
    let _lock = tool_lock();
    let project = TestProject::new(ZOTERO_QUOTE);
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &fake_bibcite(&project.parent));
    // Cancelled once the download starts: the citation is already committed.
    let cancel = AtomicBool::new(false);
    let cancel_at = |reached: &str| {
        if reached == "fulltext" {
            cancel.store(true, Ordering::Release);
        }
    };
    let result = import_reference(
        &project.root,
        "10.1234/example",
        HistoryMode::Record,
        FullText::Save,
        &cancel_at,
        &cancel,
    )
    .unwrap();
    assert_eq!(result.citation_key.as_deref(), Some("stub2024"));
    assert!(!result.already_imported);
    let keys = project::parse_bibliography(&project.bibliography())
        .into_iter()
        .map(|entry| entry.key)
        .collect::<Vec<_>>();
    assert_eq!(keys, ["possibility2024", "stub2024"]);
}

#[test]
fn resolved_snapshot_skips_search_and_preserves_metadata() {
    let raw = "@article{chosen, title={A Verified Study}, author={Smith, Ada}, year={2026}, doi={10.1234/chosen}, url={https://doi.org/10.1234/chosen}, month={September}, note={Preserve {nested} details}}";
    let resolved =
        bibcite_query_for_input(raw, &|_| panic!("a resolved snapshot must not search again"));
    assert_eq!(resolved, raw);
    let before = "@misc{chosen, title={An unrelated work}, author={Other, Author}, year={2020}}\n";
    let project = TestProject::new(before);
    let imported = import(&project.root, raw).unwrap();
    assert_eq!(imported.citation_key.as_deref(), Some("chosen-2"));
    assert!(imported.fetch_error.is_none());
    assert!(imported.paper_path.is_empty());
    let bibliography = project.bibliography();
    assert!(bibliography.starts_with(before));
    assert!(bibliography.contains("month={September}"));
    assert!(bibliography.contains("note={Preserve {nested} details}"));
    let repeated = import(&project.root, raw).unwrap();
    assert!(repeated.already_imported);
    assert_eq!(repeated.citation_key, imported.citation_key);
    assert_eq!(project.bibliography(), bibliography);
    let path = project.root.join("references.bib");
    assert!(add_citation(&path, &format!("{raw}\n{raw}"), &AtomicBool::new(false)).is_err());
    // A snapshot of an alphaXiv work keeps its webpage download routing.
    let mimo = "@misc{mimo, title={MiMo report}, author={MiMo Team}, year={2026}, url={https://www.alphaxiv.org/abs/2609.mimo-scaling-reinforcement-learning}}";
    let report = add_citation(&path, mimo, &AtomicBool::new(false)).unwrap();
    assert_eq!(bibcite_report_field(&report, "source").as_deref(), Some("webpage"));
    assert_eq!(bibcite_report_field(&report, "key").as_deref(), Some("mimo"));
}

#[cfg(unix)]
#[test]
fn resolver_never_receives_existing_citations_or_controls_duplicate_keys() {
    let _lock = tool_lock();
    let parent = crate::test_support::TempDir::new("papers");
    // Also collide with the new paper's generated key: neither old entry
    // may be replaced, even when resolution in isolation succeeds.
    let before = concat!(
        "@misc{diao2026pixels, title={Native One-Vision Models}, eprint={2605.28820}}\n",
        "@misc{diao2025pixels, title={An unrelated citation}}\n",
    );
    let path = parent.write("references.bib", before);
    let tool = parent.join("bibcite");
    write_test_tool(&tool, concat!(
            "#!/bin/sh\nset -eu\n",
            "if grep -q diao2026pixels \"$3\" 2>/dev/null; then\n",
            "  echo '{\"key\":\"diao2026pixels\",\"action\":\"exists\",\"source\":\"arxiv\"}'\n",
            "else\n",
            "  echo '@misc{diao2025pixels, title={Native Vision-Language Primitives}, author={Haiwen Diao}, year={2025}, doi={10.1234/primitives}, eprint={2510.14979v2}}' > \"$3\"\n",
            "  echo '{\"key\":\"diao2025pixels\",\"action\":\"added\",\"source\":\"arxiv\"}'\n",
            "fi\n",
        ));
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
    let output = add_citation(&path, "10.1234/primitives", &AtomicBool::new(false)).unwrap();
    let bibliography = fs::read_to_string(&path).unwrap();
    assert!(bibliography.starts_with(before));
    assert_eq!(bibcite_report_field(&output, "key").as_deref(), Some("diao2025pixels-2"));
    let entries = project::parse_bibliography(&bibliography);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[2].arxiv_id.as_deref(), Some("2510.14979v2"));
}

#[cfg(unix)]
#[test]
fn conflicting_doi_resolution_never_commits_a_different_paper() {
    let _lock = tool_lock();
    let before = "@misc{diao2026pixels, title={Native One-Vision Models}, eprint={2605.28820}}\n";
    let project = TestProject::new(before);
    let tool = project.parent.join("bibcite");
    write_test_tool(
        &tool,
        concat!(
            "#!/bin/sh\nset -eu\n",
            "echo '@misc{diao2026pixels, title={Wrong paper}, eprint={2605.28820}}' > \"$3\"\n",
            "echo '{\"key\":\"diao2026pixels\",\"source\":\"arxiv\"}'\n",
        ),
    );
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
    let error = import(&project.root, "10.1234/requested").unwrap_err();
    assert!(error.contains("requested DOI 10.1234/requested"), "{error}");
    assert_eq!(project.bibliography(), before);
}

#[cfg(unix)]
#[test]
fn duplicate_pdf_url_reuses_complete_version_equivalent_cache_without_resolution() {
    let _lock = tool_lock();
    let bibliography =
            "@article{vaswani2017attention, title={Attention Is All You Need}, eprint={1706.03762v7}}\n";
    let project = TestProject::new(bibliography);
    let markdown = "Title: Attention Is All You Need\n";
    let title = "Attention Is All You Need".to_string();
    let converter = commands::ARXIV2MD.requirement;
    project.write_bundle(
        markdown,
        &PaperMetadata::new("1706.03762", "1706.03762v7", title, converter, "", "", markdown),
    );

    let bibcite = project.parent.join("bibcite-must-not-run");
    write_test_tool(&bibcite, "#!/bin/sh\nexit 91\n");
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &bibcite);
    let stages = std::cell::RefCell::new(Vec::new());
    let result = import_reference(
        &project.root,
        "https://arxiv.org/pdf/1706.03762v3",
        HistoryMode::Record,
        FullText::Save,
        &|stage| stages.borrow_mut().push(stage.to_string()),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(result.already_imported);
    assert_eq!(result.arxiv_id, "1706.03762");
    assert_eq!(result.citation_key.as_deref(), Some("vaswani2017attention"));
    assert_eq!(result.paper_path, ".research/papers/1706.03762/paper.md");
    assert!(stages.borrow().is_empty(), "got: {:?}", stages.borrow());
    assert_eq!(project.bibliography(), bibliography);
}

/// A download failure is a note on the citation, never its undoing: the
/// entry must land in the bibliography exactly as it would for a work
/// with no full text at all. Cancelling while resolving leaves nothing
/// behind; cancelling once the full-text download starts keeps the
/// committed citation and never runs the converter.
#[cfg(unix)]
#[test]
fn a_committed_citation_survives_a_failed_or_cancelled_full_text_download() {
    let _lock = tool_lock();
    for (label, mode, cancel_stage, cited) in [
        ("download fails", HistoryMode::Defer, None, true),
        ("cancelled resolving", HistoryMode::Record, Some("resolving"), false),
        ("cancelled downloading", HistoryMode::Record, Some("fulltext"), true),
    ] {
        let project = TestProject::new("");
        let tools = &project.parent;
        let _bibcite = ToolOverride::set(&commands::BIBCITE, &fake_bibcite(tools));
        let converter = tools.join("converter");
        write_test_tool(
            &converter,
            "#!/bin/sh\ntouch \"$0.called\"\necho 'fixture conversion failure' >&2\nexit 1\n",
        );
        let _converter = ToolOverride::set(&commands::ARXIV2MD, &converter);
        let cancel = AtomicBool::new(false);
        let cancel_at = |reached: &str| {
            if Some(reached) == cancel_stage {
                cancel.store(true, Ordering::Release);
            }
        };
        let result = import_reference(
            &project.root,
            "10.1234/example",
            mode,
            FullText::Save,
            &cancel_at,
            &cancel,
        )
        .unwrap();
        assert_eq!(result.cancelled, cancel_stage.is_some(), "{label}");
        assert_eq!(result.citation_key.as_deref(), cited.then_some("stub2024"), "{label}");
        assert!(result.paper_path.is_empty(), "{label}");
        let bibliography = project.bibliography();
        assert_eq!(bibliography.contains("stub2024"), cited, "{label}");
        assert_eq!(bibliography.is_empty(), !cited, "{label}");
        if cancel_stage.is_some() {
            assert!(!tools.join("converter.called").exists(), "{label}");
        } else {
            assert_eq!(result.arxiv_id, "2401.99999");
            let error = result.fetch_error.expect("the failed download is reported");
            assert!(error.contains("fixture conversion failure"), "got: {error}");
        }
    }
}

/// A resolved citation merges into the bibliography as it is when it
/// commits: an entry added while bibcite ran is kept, never reverted to the
/// text the import began from.
#[cfg(unix)]
#[test]
fn a_citation_resolved_against_an_old_bibliography_never_reverts_the_new_one() {
    let _lock = tool_lock();
    let project = TestProject::new("");
    let bibliography = project.root.join("references.bib");
    let tool = project.parent.join("bibcite-slow");
    write_test_tool(
            &tool,
            &format!(
                concat!(
                    "#!/bin/sh\nset -eu\n",
                    "printf '@misc{{during, title={{Added meanwhile}}}}\\n' > '{}'\n",
                    "printf '@article{{stub2024, title={{Resolved}}, doi={{10.1234/example}}}}\\n' >> \"$3\"\n",
                    "echo '{{\"key\":\"stub2024\",\"source\":\"doi\"}}'\n",
                ),
                bibliography.display()
            ),
        );
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
    for mode in [HistoryMode::Record, HistoryMode::Defer] {
        project.write("references.bib", "");
        let result = import_reference(
            &project.root,
            "10.1234/example",
            mode,
            FullText::Skip,
            &|_| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.citation_key.as_deref(), Some("stub2024"));
        let text = project.bibliography();
        assert!(text.starts_with("@misc{during, title={Added meanwhile}}\n"), "{text}");
        let keys: Vec<_> =
            project::parse_bibliography(&text).into_iter().map(|entry| entry.key).collect();
        assert_eq!(keys, ["during", "stub2024"]);
    }
}

/// A batch adds citations alone, several at once: each resolves its
/// metadata in parallel and commits on top of the others, and none of them
/// downloads or converts a full text, though each carries an arXiv id that
/// would otherwise be fetched.
#[cfg(unix)]
#[test]
fn parallel_citation_only_imports_all_commit_and_save_no_full_text() {
    let _lock = tool_lock();
    let project = TestProject::new("@misc{first, title={First}}\n");
    let tools = &project.parent;
    let bibcite = tools.join("bibcite-by-doi");
    // Slow enough that the imports overlap; the entry follows the DOI asked for.
    write_test_tool(
        &bibcite,
        concat!(
            "#!/bin/sh\nset -eu\nsleep 0.3\n",
            "name=${4##*/}\n",
            "case \"$name\" in alpha) id=2401.00001 ;; *) id=2401.00002 ;; esac\n",
            "printf '@article{stub_%s, title={Paper %s}, author={Ada Smith}, year={2024}, doi={%s}, eprint={%s}}\\n' \"$name\" \"$name\" \"$4\" \"$id\" > \"$3\"\n",
            "printf '{\"key\": \"stub_%s\", \"source\": \"doi\"}\\n' \"$name\"\n",
        ),
    );
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &bibcite);
    let converter = tools.join("converter");
    write_test_tool(&converter, "#!/bin/sh\ntouch \"$0.called\"\nexit 1\n");
    let _converter = ToolOverride::set(&commands::ARXIV2MD, &converter);
    let stages = std::sync::Mutex::new(Vec::new());
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = ["10.1234/alpha", "10.1234/beta"]
            .map(|doi| {
                let (root, stages) = (&project.root, &stages);
                scope.spawn(move || {
                    import_reference(
                        root,
                        doi,
                        HistoryMode::Record,
                        FullText::Skip,
                        &|stage| stages.lock().unwrap().push(stage.to_string()),
                        &AtomicBool::new(false),
                    )
                })
            })
            .into_iter()
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap().unwrap()).collect()
    });
    let mut keys: Vec<_> =
        results.iter().map(|result| result.citation_key.clone().unwrap()).collect();
    keys.sort();
    assert_eq!(keys, ["stub_alpha", "stub_beta"]);
    for result in &results {
        assert!(!result.already_imported && !result.cancelled);
        assert!(result.paper_path.is_empty() && result.fetch_error.is_none());
        assert!(result.arxiv_id.starts_with("2401.0000"), "{}", result.arxiv_id);
    }
    let text = project.bibliography();
    assert!(text.starts_with("@misc{first, title={First}}\n"), "{text}");
    assert_eq!(project::parse_bibliography(&text).len(), 3);
    assert!(stages.lock().unwrap().iter().all(|stage| stage == "resolving"));
    assert!(!tools.join("converter.called").exists());
    // The project scaffold makes the papers folder; no paper may land in it.
    let bundles = fs::read_dir(project.root.join(".research/papers"))
        .map(|entries| entries.filter_map(Result::ok).filter(|entry| entry.path().is_dir()).count())
        .unwrap_or(0);
    assert_eq!(bundles, 0);
    assert!(list_papers(&project.root).unwrap().iter().all(|paper| !paper.has_full_text));
    // Citing an arXiv work the bibliography already holds fetches nothing either.
    let again = import_reference(
        &project.root,
        "arXiv:2401.00001",
        HistoryMode::Record,
        FullText::Skip,
        &|_| {},
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(again.already_imported);
    assert_eq!(again.citation_key.as_deref(), Some("stub_alpha"));
    assert!(!tools.join("converter.called").exists());
}

#[test]
#[ignore = "requires arxiv.org network access"]
fn pixels_import_live_preserves_both_distinct_papers() {
    let before = "@misc{diao2026pixels,title={From Pixels to Words -- Towards Native One-Vision Models at Scale},author={Haiwen Diao},year={2026},eprint={2605.28820}}";
    let raw = official_arxiv_citation("https://arxiv.org/abs/2510.14979").unwrap().unwrap();
    let entry = project::parse_bibliography(&raw).remove(0);
    assert_eq!(
        entry.title,
        "From Pixels to Words -- Towards Native Vision-Language Primitives at Scale"
    );
    assert_eq!(entry.authors.split(" and ").count(), 9);
    assert_eq!(entry.year, "2025");
    assert_eq!(entry.arxiv_id.as_deref(), Some("2510.14979"));
    let (merged, _, exists) = merge_resolved_citation(before, &raw, &entry.key).unwrap();
    assert!(!exists);
    assert!(merged.starts_with(before));
    assert_eq!(project::parse_bibliography(&merged).len(), 2);
}

#[test]
#[ignore = "Live AlphaXiv import and PDF conversion smoke test"]
fn live_mimo_import_downloads_blog_and_pdf_without_arxiv() {
    let project = TestProject::new("");
    let root = &project.root;
    let result = import_reference(
        root,
        "https://www.alphaxiv.org/abs/2609.mimo-scaling-reinforcement-learning",
        HistoryMode::Record,
        FullText::Save,
        &|stage| println!("{stage}"),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(result.fetch_error.is_none(), "{:?}", result.fetch_error);
    let papers = list_papers(root).unwrap();
    assert_eq!(papers.len(), 1);
    assert!(papers[0].has_blog);
    assert!(papers[0].has_full_text);
    assert!(read_paper_blog_local(root, &papers[0].arxiv_id).unwrap().unwrap().contains("[p8]"));
    assert!(read_paper(root, &papers[0].arxiv_id).unwrap().contains("reinforcement"));
    let resolved = project::resolve_citation_query(&papers[0].title).unwrap();
    assert_eq!(resolved.url, papers[0].url.as_deref().unwrap());
    assert_eq!(resolved.year, "2026");
    let from_title = import(root, &papers[0].title).unwrap();
    assert!(from_title.already_imported);
    assert_eq!(from_title.arxiv_id, papers[0].arxiv_id);
}

#[test]
#[ignore = "requires network access"]
fn imports_markdown_and_a_real_citation() {
    let project = TestProject::new("");
    let result = import(&project.root, "1706.03762").unwrap();
    assert_eq!(result.arxiv_id, "1706.03762");
    assert_eq!(result.title, "Attention Is All You Need");
    // --frontmatter leads the full text with a YAML block.
    let paper = fs::read_to_string(project.root.join(&result.paper_path)).unwrap();
    assert!(paper.starts_with("---"));
    // The alphaXiv overview is fetched and stored as the blog view.
    assert!(project.root.join(".research/papers/1706.03762/blog.md").exists());
    assert!(!project.bibliography().is_empty());
}
