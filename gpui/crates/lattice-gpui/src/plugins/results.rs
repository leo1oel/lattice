//! A command's result as the palette's rows (`src/plugins/plugin-run.tsx`
//! in the Tauri app): items in the plugin's order; diagnostics grouped by
//! file, the files in the order they first appear, each under a header row;
//! a message as one Markdown block. ↑↓ move between the rows that act (an
//! item, a diagnostic), never onto a file header.

use lattice_core::plugins::{ActionKind, CommandResult, Diagnostic, Item};

/// One row of a result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    /// A file's header over its diagnostics.
    File(String),
    /// `items[index]`.
    Item(usize),
    /// `items[index]` of a diagnostics result.
    Diagnostic(usize),
}

impl Row {
    /// Whether ↑↓ stop on it and Return acts on it.
    pub fn acts(&self) -> bool {
        !matches!(self, Row::File(_))
    }
}

/// The rows of `result`; a message has none (it is one block).
pub fn rows(result: &CommandResult) -> Vec<Row> {
    match result {
        CommandResult::Message { .. } => Vec::new(),
        CommandResult::Items { items, .. } => (0..items.len()).map(Row::Item).collect(),
        CommandResult::Diagnostics { items, .. } => grouped(items),
    }
}

fn grouped(items: &[Diagnostic]) -> Vec<Row> {
    let mut files: Vec<&str> = Vec::new();
    for item in items {
        if !files.contains(&item.file.as_str()) {
            files.push(&item.file);
        }
    }
    let mut rows = Vec::new();
    for file in files {
        rows.push(Row::File(file.to_string()));
        rows.extend(
            items
                .iter()
                .enumerate()
                .filter(|(_, item)| item.file == file)
                .map(|(index, _)| Row::Diagnostic(index)),
        );
    }
    rows
}

/// The next row that acts from `from` by `step` (±1), wrapping; `from`
/// itself when no other does.
pub fn step(rows: &[Row], from: usize, step: isize) -> usize {
    let count = rows.len() as isize;
    if count == 0 {
        return 0;
    }
    let mut at = from as isize;
    for _ in 0..count {
        at = (at + step).rem_euclid(count);
        if rows[at as usize].acts() {
            return at as usize;
        }
    }
    from
}

/// The first row that acts.
pub fn first(rows: &[Row]) -> usize {
    rows.iter().position(Row::acts).unwrap_or(0)
}

/// What Return does on an item: its first action.
pub fn item_default(item: &Item) -> Option<&ActionKind> {
    item.actions.first().map(|action| &action.kind)
}

/// What Return and a click do on a diagnostic: open its place.
pub fn diagnostic_default(diagnostic: &Diagnostic) -> ActionKind {
    ActionKind::Reveal {
        file: diagnostic.file.clone(),
        line: diagnostic.line,
    }
}

/// The summary a result carries, if any.
pub fn summary(result: &CommandResult) -> Option<&str> {
    match result {
        CommandResult::Message { summary, .. }
        | CommandResult::Items { summary, .. }
        | CommandResult::Diagnostics { summary, .. } => summary.as_deref(),
    }
}
