//! Everything Lattice does to a project folder on disk.
//!
//! - [`create`] — new projects from venue templates and the tutorial.
//! - [`manifest`] — opening a folder, `.research/project.json`, root documents,
//!   compile roots, and the editor-comments sidecar.
//! - [`paths`] — the path guards every file operation goes through, and the
//!   table of text source kinds.
//! - [`tree`] — file-tree views, content classification, and reading text
//!   files.
//! - [`bibliography`] — BibTeX parsing, entry editing, and SyncTeX hops
//!   between `.bib` and `.bbl`; [`citation_lookup`] resolves new citations.
//! - [`symbols`] and [`references`] — `\label`/`\cite` find, rename, and
//!   removal, and the reference hover index.
//! - [`search`] — project search, TODO markers, and find/replace.
//! - [`entries`], [`imports`], [`assets`], [`archive`] — Project-pane file
//!   operations, drops and uploads, figure previews, and ZIP packs.
//! - [`history`] — undoable transactions and the history log.
//!
//! Content changes go through `history` (atomic writes via
//! `crate::project_fs::ProjectDir`, an undo record, a search-index refresh).

mod archive;
mod assets;
mod bibliography;
mod citation_lookup;
mod create;
mod entries;
mod history;
mod imports;
mod manifest;
mod paths;
mod references;
mod search;
mod symbols;
#[cfg(test)]
pub(crate) mod test_support;
mod tree;

pub(crate) use archive::safe_zip_entry_name;
pub use archive::{export_project_zip, import_project_zip};
pub use assets::{prepare_latex_figure, read_asset, read_asset_range, save_asset_copy};
pub use bibliography::{
    bbl_target_for_bib, bib_target_for_bbl, citation_keys, citations, read_bib_entry,
    save_bib_entry,
};
pub(crate) use bibliography::{
    bibliography_arxiv_id, bibliography_entry_spans, iter_bibliography_sources, normalize_doi,
    parse_bibliography, parse_bibliography_fields_raw, parse_bibliography_fields_syntax,
};
pub use citation_lookup::resolve_citation_query;
pub use create::{create_tutorial, create_with_venue, Venue};
pub use entries::{create_entry, create_open_slide_deck, delete_entry, move_entry, rename_entry};
pub use history::{
    apply_citation_transaction, apply_citation_transaction_checked, apply_editor_transaction,
    delete_history, get_history_entry, history, revert, EditorWriteResult,
};
pub use imports::{
    import_assets, import_files, import_files_with_copy, import_image_bytes, import_sources,
    read_agent_composer_files, write_bytes, AgentComposerFile, ImportedProjectFile,
};
pub use manifest::{
    has_latexmkrc, latexmk_engine_arg, open, read_editor_comments, read_manifest,
    resolve_compile_root, set_compile_root, set_spelling_words, update_manifest_settings,
    write_editor_comments,
};
pub use paths::safe_path;
pub(crate) use paths::{creation_path, stays_inside};
pub use references::references;
pub(crate) use search::{
    file_search_result, matches_search, search_terms, searchable_text_lines, searchable_text_path,
};
pub use search::{list_todos, preview_replace_in_project, replace_in_project, search_files};
pub(crate) use symbols::remove_citation_usages;
pub use symbols::{find_citation_usages, unused_symbols, Symbol};
pub(crate) use tree::{project_tree_path_visible, scan_tree, tree_files, TreeView};
pub use tree::{read_file, stat_file, ProjectFileStat};
// Fixtures for other modules' tests.
#[cfg(test)]
pub use {
    create::{create, create_blank, default_manifest},
    history::apply_transaction,
    manifest::write_manifest,
};

pub(crate) fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// 1-based line of byte `offset` (clamped to the text).
fn line_number_at(source: &str, offset: usize) -> u32 {
    source[..offset.min(source.len())].bytes().filter(|byte| *byte == b'\n').count() as u32 + 1
}

/// The first position at or after `position` whose byte `skip` rejects.
fn skip_bytes(bytes: &[u8], mut position: usize, skip: impl Fn(&u8) -> bool) -> usize {
    while bytes.get(position).is_some_and(&skip) {
        position += 1;
    }
    position
}

/// A trimmed line clipped for display in a result list.
pub(crate) fn clip_line(line: &str, limit: usize) -> String {
    crate::util::truncate_chars(line.trim(), limit)
}
