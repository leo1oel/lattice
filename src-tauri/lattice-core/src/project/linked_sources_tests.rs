//! A project whose `.bib` is a symbolic link to a shared library (a Zotero /
//! Better BibTeX export) and which links in a macro folder. TeX follows both,
//! so the project-wide tools must keep working; writes still refuse the links.

use super::test_support::{temp_root, Fixture};
use super::{
    citations, create_blank, list_todos, preview_replace_in_project, replace_in_project, safe_path,
    search_files, unused_symbols,
};
use crate::test_support::symlink;
use std::fs;

const LIBRARY: &str =
    "@article{vaswani2017,\n  title={Attention Is All You Need},\n  year={2017}\n}\n";

fn linked_project() -> (Fixture, std::path::PathBuf) {
    let parent = temp_root("linked-sources");
    let root = create_blank(&parent, "sym").unwrap();
    let fixture = Fixture { parent, root };
    let library = fixture.outside("library/library.bib", LIBRARY);
    fixture.outside("library/macros/defs.tex", "% TODO outside the project\n");
    fixture.write("references.bib", "@book{knuth1984,\n  title={The TeXbook},\n  year={1984}\n}\n");
    fixture.write(
        "main.tex",
        "\\documentclass{article}\n\\begin{document}\n% TODO intro\nIntro \\cite{knuth1984}.\n\\end{document}\n",
    );
    symlink(&library, fixture.path("zotero.bib")).unwrap();
    symlink(fixture.parent.join("library/macros"), fixture.path("shared")).unwrap();
    (fixture, library)
}

#[test]
fn citation_index_reads_a_linked_bibliography() {
    let (fixture, _) = linked_project();
    let keys: Vec<String> =
        citations(&fixture.root).unwrap().citations.into_iter().map(|c| c.key).collect();
    assert!(keys.contains(&"knuth1984".to_string()), "{keys:?}");
    assert!(keys.contains(&"vaswani2017".to_string()), "{keys:?}");
    let unused = unused_symbols(&fixture.root).unwrap();
    assert_eq!(unused.citations, vec!["vaswani2017".to_string()]);
}

#[test]
fn project_search_and_replace_skip_links() {
    let (fixture, library) = linked_project();
    let root = &fixture.root;
    let hits = search_files(root, "TeXbook").unwrap();
    assert!(hits.iter().any(|hit| hit.path == "references.bib"), "{hits:?}");
    // A Chinese query reads files instead of the index.
    assert!(search_files(root, "注意力").unwrap().is_empty());
    assert!(search_files(root, "zotero").unwrap().is_empty());
    assert_eq!(list_todos(root).unwrap().len(), 1);

    let preview = preview_replace_in_project(root, "Attention", false, false).unwrap();
    assert_eq!(preview.replacements, 0);
    let preview = preview_replace_in_project(root, "TeXbook", false, false).unwrap();
    assert_eq!(preview.files, 1);
    let replaced = replace_in_project(root, "Attention", "Focus", false, false).unwrap();
    assert_eq!(replaced.replacements, 0);
    assert_eq!(fs::read_to_string(library).unwrap(), LIBRARY);
}

#[test]
fn writes_still_refuse_a_linked_bibliography() {
    let (fixture, _) = linked_project();
    assert!(safe_path(&fixture.root, "zotero.bib").is_err());
    assert!(safe_path(&fixture.root, "shared/defs.tex").is_err());
    assert!(super::paths::linked_read_path(&fixture.root, "shared/defs.tex").is_err());
}
