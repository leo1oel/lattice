//! Getting a manuscript ready to send, ported from the Tauri app's
//! `src/project/`: the TODOs tool panel (`todo-scavenger-panel.tsx`), the
//! symbol references panel under the editor (`references-panel.tsx`) and
//! the arXiv export sheet (`arxiv-export-dialog.tsx`, `arxiv-export.ts`).
//! lattice-core does the work, as it does for the Tauri app
//! (`project::list_todos`, `project::find_symbol_occurrences`,
//! `latex::arxiv`).

pub mod arxiv;
pub mod checklist;
pub mod references;
pub mod todos;

/// A byte count as the Tauri app writes one (`formatSize` in
/// `src/app-utils.ts`, through `Intl.NumberFormat`'s short units): whole
/// kilobytes (never under 1) below a megabyte, then megabytes to one
/// decimal, a trailing `.0` dropped.
pub fn format_size(bytes: u64) -> String {
    if bytes < 1_000_000 {
        format!("{} kB", ((bytes as f64 / 1_000.).round() as u64).max(1))
    } else {
        let megabytes = format!("{:.1}", bytes as f64 / 1_000_000.);
        format!("{} MB", megabytes.trim_end_matches(".0"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sizes_read_as_the_tauri_app_writes_them() {
        assert_eq!(super::format_size(12), "1 kB");
        assert_eq!(super::format_size(48_400), "48 kB");
        assert_eq!(super::format_size(2_000_000), "2 MB");
        assert_eq!(super::format_size(2_460_000), "2.5 MB");
    }
}
