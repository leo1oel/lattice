//! The surfaces that search the project: quick open (⌘P) with its `@` and
//! `:` prefixes, Find in project (⌘⇧F) and Replace in project (⌘⇧H), as
//! the Tauri app has them (`src/project/quick-open-dialog.tsx`,
//! `project-find-dialog.tsx`, `project-replace-dialog.tsx`). The window's
//! side of each (what opens it, what a pick does) is in
//! `shell/documents.rs`.

mod field;
pub(crate) use field::search_field;
pub mod find;
pub mod goto_line;
pub mod insert_pickers;
pub mod quick_open;
mod ranking;
pub mod replace;
pub(crate) mod sheet;
mod symbols;
