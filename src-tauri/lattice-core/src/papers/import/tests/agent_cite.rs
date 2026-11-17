//! What the Agent's cite answers when the work is already cited, and when
//! Lattice's shared literature service has spent its daily budget.

use super::*;

/// A bibcite whose `add` resolves `10.5555/<name>` (or the published ResNet
/// record for its DOI), refusing every call routed through the public
/// literature service as the exhausted service does, and logging each call
/// with its routing.
fn quota_exhausted_bibcite(project: &TestProject) -> (std::path::PathBuf, std::path::PathBuf) {
    let log = project.parent.join("calls.log");
    let tool = project.parent.join("bibcite");
    write_test_tool(
        &tool,
        &format!(
            r#"#!/bin/sh
set -eu
[ "$1" = add ] && [ "$2" = --no-tidy ] || exit 23
echo "add ${{BIBCITE_PUBLIC_SERVICE_URL:+public}}${{BIBCITE_PUBLIC_SERVICE_URL:-direct}} $4" | sed 's/public[^ ]*/public/' >> '{log}'
if [ -n "${{BIBCITE_PUBLIC_SERVICE_URL:-}}" ]; then
  echo "[bibcite] query understood as doi: $4" >&2
  echo "[bibcite] internal error: SourceUnavailable: public literature service daily_quota" >&2
  exit 1
fi
if [ "$4" = 10.5555/resnet ]; then
  printf '@inproceedings{{he2016deep, title={{Deep Residual Learning for Image Recognition}}, author={{He, Kaiming and Zhang, Xiangyu}}, booktitle={{IEEE Conference on Computer Vision and Pattern Recognition (CVPR)}}, year={{2016}}, doi={{10.5555/resnet}}}}\n' > "$3"
  echo '{{"key": "he2016deep", "source": "crossref", "action": "added"}}'
  exit 0
fi
name=${{4#10.5555/}}
printf '@article{{smith2024%s, title={{Paper %s}}, author={{Smith, Alice}}, journal={{Journal of Tests}}, year={{2024}}, doi={{%s}}}}\n' "$name" "$name" "$4" > "$3"
printf '{{"key": "smith2024%s", "source": "crossref", "action": "added"}}\n' "$name"
"#,
            log = log.display()
        ),
    );
    (tool, log)
}

fn cite(root: &Path, query: &str) -> Result<ImportResult, String> {
    import_reference(
        root,
        query,
        HistoryMode::Defer,
        FullText::Skip,
        &|_| {},
        &AtomicBool::new(false),
    )
}

#[test]
fn a_doi_cite_goes_direct_once_the_shared_service_is_out_of_quota_and_replays_known_dois() {
    let _lock = tool_lock();
    let project = TestProject::new("");
    let (tool, log) = quota_exhausted_bibcite(&project);
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);

    let first = cite(&project.root, "10.5555/one").unwrap();
    assert_eq!(first.citation_key.as_deref(), Some("smith2024one"));
    let note = first.note.unwrap_or_default();
    assert!(note.contains("used up today's quota") && note.contains("directly"), "{note}");

    // The refusal paused the routing: the next DOI goes direct at once, and
    // a DOI cited before is not looked up again.
    let second = cite(&project.root, "10.5555/two").unwrap();
    assert_eq!(second.citation_key.as_deref(), Some("smith2024two"));
    let again = TestProject::new("");
    assert_eq!(
        cite(&again.root, "10.5555/one").unwrap().citation_key.as_deref(),
        Some("smith2024one")
    );
    assert_eq!(
        std::fs::read_to_string(log).unwrap(),
        "add public 10.5555/one\nadd direct 10.5555/one\nadd direct 10.5555/two\n"
    );
}

/// cite never rewrites an entry the bibliography has; it says so, and says
/// what the record it resolved would have changed. (The preprint case, which
/// points at upgrade_bibliography, is `notes`' unit test.)
#[test]
fn citing_an_already_cited_work_says_it_was_left_unchanged_and_what_differs() {
    let _lock = tool_lock();
    let cited = "@inproceedings{he2016deep,\n  title = {Deep Residual Learning for Image Recognition},\n  author = {He, Kaiming and Zhang, Xiangyu},\n  booktitle = {CVPR},\n  year = {2016},\n  doi = {10.5555/resnet},\n  note = {Edited by a co-author}\n}\n";
    let project = TestProject::new(cited);
    let (tool, _) = quota_exhausted_bibcite(&project);
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
    crate::commands::reset_public_service();

    let result = cite(&project.root, "10.5555/resnet").unwrap();
    assert!(result.already_imported);
    assert_eq!(result.citation_key.as_deref(), Some("he2016deep"));
    assert_eq!(project.bibliography(), cited);
    let note = result.note.unwrap_or_default();
    assert!(note.starts_with("'he2016deep' was already in the bibliography, so cite returned its key and left the entry unchanged."), "{note}");
    assert!(note.contains("differs in booktitle;"), "{note}");
    assert!(note.contains("citation review"), "{note}");
}

/// The live repro: the Agent cited the DOI of a preprint's publication, and
/// cite added it as a second reference beside the preprint (no shared id,
/// another year). It is the same work; cite answers with the preprint's key
/// and says that upgrade_bibliography moves it to the publication.
#[test]
fn citing_the_publication_of_a_cited_preprint_does_not_add_the_work_twice() {
    let _lock = tool_lock();
    let preprint = "@misc{he2015deep,\n  title = {Deep Residual Learning for Image Recognition},\n  author = {He, Kaiming and Zhang, Xiangyu},\n  journal = {arXiv preprint arXiv:1512.03385},\n  eprint = {1512.03385},\n  year = {2015}\n}\n";
    let project = TestProject::new(preprint);
    let (tool, _) = quota_exhausted_bibcite(&project);
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
    crate::commands::reset_public_service();

    let result = cite(&project.root, "10.5555/resnet").unwrap();
    assert!(result.already_imported);
    assert_eq!(result.citation_key.as_deref(), Some("he2015deep"));
    assert_eq!(project.bibliography(), preprint);
    let note = result.note.unwrap_or_default();
    assert!(note.contains("differs in year, booktitle, doi, type;"), "{note}");
    assert!(note.contains("upgrade_bibliography replaces it with its published version"), "{note}");
}

/// A downloaded Overleaf project whose manifest an earlier version pointed
/// at the sync base (`.research/overleaf-base/main.bib`): the cite lands in
/// the `main.bib` that `main.tex` compiles against, the base copy is left
/// alone, and the manifest follows.
#[test]
fn cite_writes_the_bibliography_the_document_uses_never_the_overleaf_base() {
    let _lock = tool_lock();
    let project = TestProject::new("");
    let tool = project.parent.join("bibcite");
    write_test_tool(
        &tool,
        r#"#!/bin/sh
printf '@article{smith2024one, title={Paper one}, author={Smith, Alice}, journal={Journal of Tests}, year={2024}, doi={%s}}\n' "$4" > "$3"
echo '{"key": "smith2024one", "source": "crossref", "action": "added"}'
"#,
    );
    let _bibcite = ToolOverride::set(&commands::BIBCITE, &tool);
    let main =
        "\\documentclass{article}\n\\begin{document}\n\\bibliography{main}\n\\end{document}\n";
    let root_document =
        project::read_manifest(&project.root).unwrap().root_documents[0].path.clone();
    for base in ["", ".research/overleaf-base/"] {
        project.write(&format!("{base}{root_document}"), main);
        project.write(&format!("{base}main.bib"), "");
    }
    let mut manifest = project::read_manifest(&project.root).unwrap();
    manifest.primary_bibliography = ".research/overleaf-base/main.bib".into();
    project::write_manifest(&project.root, &manifest).unwrap();

    let cited = cite(&project.root, "10.5555/one").unwrap();

    assert_eq!(cited.citation_key.as_deref(), Some("smith2024one"));
    let main_bib = fs::read_to_string(project.root.join("main.bib")).unwrap();
    assert!(main_bib.contains("@article{smith2024one,"), "{main_bib}");
    assert_eq!(
        fs::read_to_string(project.root.join(".research/overleaf-base/main.bib")).unwrap(),
        ""
    );
    assert_eq!(project.bibliography(), "");
    assert_eq!(project::read_manifest(&project.root).unwrap().primary_bibliography, "main.bib");
}
