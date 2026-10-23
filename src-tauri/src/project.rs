//! Everything Lattice does to a project folder on disk.
//!
//! - [`create`] — new projects from venue templates and the tutorial.
//! - [`manifest`] — opening a folder, `.research/project.json`, root documents,
//!   and compile roots.
//! - [`annotations`] — local annotations, their revision rounds and the
//!   rounds' snapshots.
//! - [`linked_bibliography`] — a reference manager's `.bib` linked to the
//!   project's bibliography.
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

mod annotations;
mod archive;
mod assets;
mod bibliography;
mod citation_lookup;
mod create;
mod entries;
mod history;
mod imports;
mod linked_bibliography;
mod manifest;
mod manifest_settings;
mod paths;
mod references;
mod search;
mod symbols;
pub mod templates;
#[cfg(test)]
pub(crate) mod test_support;
mod tree;

pub(crate) use annotations::retain_open_annotation_saves;
pub use annotations::{
    read_annotation_round, read_annotations, save_annotation_round, write_annotations,
    AnnotationRound, Annotations, EditorComment,
};
pub use archive::{export_project_zip, import_project_zip};
pub(crate) use archive::{safe_zip_entry_name, zip_time};
pub use assets::AssetPreview;
pub use assets::{prepare_latex_figure, read_asset, read_asset_range, save_asset_copy};
pub use bibliography::{
    bbl_target_for_bib, bib_target_for_bbl, citations, read_bib_entry, save_bib_entry,
};
pub(crate) use bibliography::{
    bibliography_arxiv_id, bibliography_entry_spans, iter_bibliography_sources, normalize_doi,
    parse_bibliography, parse_bibliography_fields_raw, parse_bibliography_fields_syntax,
};
pub use citation_lookup::resolve_citation_query;
pub use create::{create_tutorial, create_with_venue, Venue};
pub use entries::{create_entry, create_open_slide_deck, delete_entry, move_entry, rename_entry};
pub(crate) use history::retain_open_history;
pub use history::{
    apply_annotation_restore, apply_citation_transaction, apply_citation_transaction_checked,
    apply_editor_transaction, delete_history, get_history_entry, history, revert,
    EditorWriteResult,
};
pub use history::{HistoryItem, TransactionRecord};
pub use imports::{
    import_assets, import_files, import_image_bytes, import_sources, read_agent_composer_files,
    write_bytes, AgentComposerFile, ImportRequest, NameConflict, ProjectImport,
};
pub use linked_bibliography::{
    read_bibliography_source, read_linked_bibliography, save_linked_bibliography,
    unlink_bibliography, LinkedBibliography,
};
pub(crate) use manifest::ensure_ignore_line;
pub use manifest::{
    classify_open_error, has_latexmkrc, latexmk_engine_arg, open, read_manifest,
    resolve_compile_root, set_compile_root, tex_program_engine,
};
pub use manifest_settings::{
    set_deadline, set_spelling_words, set_submission_items, update_manifest_settings,
};
pub use paths::safe_path;
pub(crate) use paths::{creation_path, stays_inside};
pub use references::references;
pub use references::ReferenceInfo;
pub(crate) use search::{
    file_search_result, matches_search, search_terms, searchable_text_lines, searchable_text_path,
};
pub use search::{list_todos, preview_replace_in_project, replace_in_project, search_files};
pub use search::{ReplacePreview, ReplaceResult, TodoHit};
pub(crate) use symbols::remove_citation_usages;
pub use symbols::{citation_usages, find_citation_usages, unused_symbols, Symbol};
pub use symbols::{RenameSymbolResult, UnusedSymbols};
pub(crate) use tree::{project_tree_path_visible, scan_tree, tree_files, TreeView};
pub use tree::{read_file, stat_file, ProjectFileStat};
// Fixtures for other modules' tests.
#[cfg(test)]
pub use {
    create::{create, create_blank, default_manifest},
    history::apply_transaction,
    manifest::write_manifest,
};

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
