use super::*;
use crate::project::test_support::Fixture;
use crate::project::{open, read_manifest};

const CVPR_MAIN: &str = "\\documentclass{article}\n\\begin{document}\nText~\\cite{a}.\n\
% \\bibliography{commented}\n{\\small\\bibliographystyle{ieeenat_fullname}\\bibliography{main}}\n\
\\end{document}\n";

/// An Overleaf download: the project's files, and the sync base beside them
/// under `.research/overleaf-base/`, written before the folder first opens.
fn overleaf_download(label: &str) -> Fixture {
    let fixture = Fixture::folder(label, "cvpr");
    for root in ["", ".research/overleaf-base/"] {
        fixture.write(&format!("{root}main.tex"), CVPR_MAIN);
        fixture.write(&format!("{root}main.bib"), "@misc{a, title={A}}\n");
    }
    fixture
}

#[test]
fn an_overleaf_download_cites_into_the_bibliography_its_document_uses() {
    let fixture = overleaf_download("bib-target-overleaf");
    let snapshot = open(&fixture.root).unwrap();
    assert_eq!(snapshot.manifest.primary_bibliography, "main.bib");
    let target = citation_bibliography(&fixture.root).unwrap();
    assert_eq!(target.path, "main.bib");
    assert_eq!(target.used, ["main.bib"]);
    assert_eq!(target.note(), None);
}

#[test]
fn a_manifest_pointing_at_the_overleaf_base_is_repaired() {
    let fixture = overleaf_download("bib-target-repair");
    open(&fixture.root).unwrap();
    // What an earlier version could record for this layout.
    let mut manifest = read_manifest(&fixture.root).unwrap();
    manifest.primary_bibliography = ".research/overleaf-base/main.bib".into();
    write_manifest(&fixture.root, &manifest).unwrap();

    assert_eq!(citation_bibliography(&fixture.root).unwrap().path, "main.bib");
    assert_eq!(read_manifest(&fixture.root).unwrap().primary_bibliography, "main.bib");

    // Reopening repairs it too, before anything is cited.
    manifest.primary_bibliography = ".research/overleaf-base/main.bib".into();
    write_manifest(&fixture.root, &manifest).unwrap();
    assert_eq!(open(&fixture.root).unwrap().manifest.primary_bibliography, "main.bib");
}

#[test]
fn an_internal_bibliography_is_never_chosen_without_a_document_naming_one() {
    let fixture = Fixture::folder("bib-target-nodoc", "notes");
    fixture.write("main.tex", "\\documentclass{article}\n\\begin{document}x\\end{document}\n");
    fixture.write(".research/overleaf-base/main.bib", "");
    fixture.write("refs/library.bib", "");
    assert_eq!(open(&fixture.root).unwrap().manifest.primary_bibliography, "refs/library.bib");

    let bare = Fixture::folder("bib-target-bare", "bare");
    bare.write("main.tex", "\\documentclass{article}\n\\begin{document}x\\end{document}\n");
    bare.write(".research/overleaf-base/main.bib", "");
    assert_eq!(open(&bare.root).unwrap().manifest.primary_bibliography, "references.bib");
}

#[test]
fn several_bibliographies_pick_the_primary_else_the_first_named_and_say_so() {
    let fixture = Fixture::folder("bib-target-several", "paper");
    fixture.write(
        "paper/main.tex",
        "\\documentclass{article}\n\\usepackage{biblatex}\n\\addbibresource{../shared/extra.bib}\n\
         \\input{sections/refs}\n\\begin{document}x\\end{document}\n",
    );
    fixture.write("paper/sections/refs.tex", "\\bibliography{own,missing}\n");
    fixture.write("paper/own.bib", "");
    fixture.write("shared/extra.bib", "");
    let target = resolve_target(&fixture.root, "", Some("paper/main.tex"));
    assert_eq!(target.used, ["shared/extra.bib", "paper/own.bib", "paper/missing.bib"]);
    assert_eq!(target.path, "shared/extra.bib");
    let note = target.note().unwrap();
    assert!(note.contains("new entries go to shared/extra.bib, the first it names"), "{note}");

    // The writer's primary wins when the document uses it.
    let target = resolve_target(&fixture.root, "paper/own.bib", Some("paper/main.tex"));
    assert_eq!(target.path, "paper/own.bib");
    // A primary the document does not use loses to the document.
    let target = resolve_target(&fixture.root, "references.bib", Some("paper/main.tex"));
    assert_eq!(target.path, "shared/extra.bib");
}

#[test]
fn a_bibliography_name_resolves_beside_the_document_then_at_the_root() {
    let fixture = Fixture::folder("bib-target-resolve", "paper");
    fixture.write("tex/main.tex", "\\bibliography{refs}\n");
    fixture.write("refs.bib", "");
    assert_eq!(document_bibliographies(&fixture.root, "tex/main.tex"), ["refs.bib"]);
    fixture.write("tex/refs.bib", "");
    assert_eq!(document_bibliographies(&fixture.root, "tex/main.tex"), ["tex/refs.bib"]);
    // Out of the project, or into a hidden folder: never a target.
    fixture.write("tex/main.tex", "\\bibliography{../../outside,.research/x}\n");
    assert!(document_bibliographies(&fixture.root, "tex/main.tex").is_empty());
}

/// The CVPR kit's `\bibliography{\paperbib}`, whose macro is set by
/// whether `references.bib` sits beside the document or at the root.
const PAPERBIB_MAIN: &str = "\\documentclass{article}\n\\begin{document}\nText~\\cite{a}.\n\
    \\newread\\paperbibprobe\n\\openin\\paperbibprobe=references.bib\n\
    \\ifeof\\paperbibprobe \\def\\paperbib{../references}\\else \\def\\paperbib{references}\\fi\n\
    \\closein\\paperbibprobe\n\\bibliography{\\paperbib}\n\\end{document}\n";

fn paperbib_project(label: &str) -> Fixture {
    let fixture = Fixture::folder(label, "native");
    fixture.write("cvpr/main.tex", PAPERBIB_MAIN);
    fixture.write("references.bib", "@misc{a, title={A}}\n");
    fixture.write("author-kit/main.bib", "@misc{kit, title={Kit}}\n");
    open(&fixture.root).unwrap();
    let mut manifest = read_manifest(&fixture.root).unwrap();
    for document in &mut manifest.root_documents {
        document.is_default = false;
    }
    manifest.root_documents.push(crate::models::RootDocument {
        path: "cvpr/main.tex".into(),
        name: "main".into(),
        is_default: true,
        chosen: false,
    });
    write_manifest(&fixture.root, &manifest).unwrap();
    fixture
}

#[test]
fn a_bibliography_named_by_a_macro_resolves_to_the_file_it_defines() {
    let fixture = paperbib_project("bib-target-paperbib");
    assert_eq!(document_bibliographies(&fixture.root, "cvpr/main.tex"), ["references.bib"]);
    assert_eq!(open(&fixture.root).unwrap().manifest.primary_bibliography, "references.bib");
    assert_eq!(crate::papers::list_papers(&fixture.root).unwrap().len(), 1);

    // An undefined macro names no file at all.
    fixture.write("tex/main.tex", "\\bibliography{\\undefinedbib}\n");
    assert!(document_bibliographies(&fixture.root, "tex/main.tex").is_empty());
}

#[test]
fn a_macro_primary_an_earlier_version_recorded_heals_on_open() {
    let fixture = paperbib_project("bib-target-paperbib-heal");
    // What an earlier version recorded from `\bibliography{\paperbib}`.
    let mut manifest = read_manifest(&fixture.root).unwrap();
    manifest.primary_bibliography = "cvpr/\\paperbib.bib".into();
    write_manifest(&fixture.root, &manifest).unwrap();
    assert_eq!(open(&fixture.root).unwrap().manifest.primary_bibliography, "references.bib");

    // With a document that names none, a gone or macro primary gives way to
    // the shallowest .bib there is, not a template's.
    let target = resolve_target(&fixture.root, "cvpr/\\paperbib.bib", None);
    assert_eq!(target.path, "references.bib");
    let target = resolve_target(&fixture.root, "gone.bib", None);
    assert_eq!(target.path, "references.bib");
    // A primary not written yet stays when there is no .bib to take instead.
    let bare = Fixture::folder("bib-target-unwritten", "bare");
    assert_eq!(resolve_target(&bare.root, "refs.bib", None).path, "refs.bib");
}

/// Leo's CVPR project after an earlier Papers wrote to its macro primary:
/// the stray `cvpr/\paperbib.bib` is on disk beside the real bibliography.
/// Whatever names it (the manifest, a walk for a `.bib`, the document's macro)
/// no write lands there again: Overleaf refuses the name, so each sync would.
#[cfg(unix)]
#[test]
fn no_write_ever_lands_on_a_bibliography_named_as_overleaf_refuses() {
    let fixture = paperbib_project("bib-target-stray");
    fs::create_dir_all(fixture.root.join("cvpr")).unwrap();
    let stray = fixture.root.join("cvpr").join(r"\paperbib.bib");
    fs::write(&stray, "@misc{a, title={A}}\n").unwrap();
    fs::remove_file(fixture.root.join("references.bib")).unwrap();
    fs::remove_file(fixture.root.join("author-kit/main.bib")).unwrap();

    // Neither the manifest's macro primary nor the only .bib on disk is
    // taken, and with nothing else to take the default is.
    let target = resolve_target(&fixture.root, r"cvpr/\paperbib.bib", None);
    assert_eq!(target.path, "references.bib");
    assert_eq!(first_visible_bibliography(&fixture.root), None);
    let mut manifest = read_manifest(&fixture.root).unwrap();
    manifest.primary_bibliography = r"cvpr/\paperbib.bib".into();
    write_manifest(&fixture.root, &manifest).unwrap();
    let target = citation_bibliography(&fixture.root).unwrap();
    assert!(writable_bibliography(&target.path), "{}", target.path);
    assert_ne!(target.path, r"cvpr/\paperbib.bib");

    // A write naming it outright is refused before the disk is touched,
    // whether through the transaction log or the entry editor, which writes
    // to the manifest's primary as it stands.
    let before = fs::read_to_string(&stray).unwrap();
    let error = crate::project::apply_citation_transaction(
        &fixture.root,
        "Add a",
        vec![(r"cvpr/\paperbib.bib".into(), format!("{before}@misc{{b,}}\n"))],
    )
    .unwrap_err();
    assert!(error.contains("Overleaf does not allow that name"), "{error}");
    manifest.primary_bibliography = r"cvpr/\paperbib.bib".into();
    write_manifest(&fixture.root, &manifest).unwrap();
    let error =
        crate::project::save_bib_entry(&fixture.root, "b", "@misc{b, title={B}}").unwrap_err();
    assert!(error.contains("Overleaf does not allow that name"), "{error}");
    assert_eq!(fs::read_to_string(&stray).unwrap(), before);
    for bad in ["refs/*.bib", ".research/overleaf-base/main.bib", "", " refs.bib"] {
        assert!(!writable_bibliography(bad), "{bad:?}");
    }
}
