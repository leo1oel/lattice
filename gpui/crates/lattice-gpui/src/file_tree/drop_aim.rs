//! Where a drag over the Project tree is aimed, and how the rows show it
//! (`paintDropTarget`): the folder's own row ringed and raised, the rows
//! inside it filled, the whole tree washed for the project root.

use gpui::App;
use lattice_ui::components::DropMark;

/// Where a drag over the tree is aimed, as its moves last saw it: whether
/// the pointer is over the tree at all, and the folder of the row under it.
/// The tree's own listener sees each move first and the rows' after, so a
/// move off every row leaves the project root.
#[derive(Default)]
pub(super) struct Aim {
    pub(super) inside: bool,
    pub(super) row: Option<String>,
}

impl Aim {
    /// The folder a drop would land in now ("" is the project root).
    pub(super) fn folder(&self, cx: &App) -> Option<String> {
        (self.inside && cx.has_active_drag()).then(|| self.row.clone().unwrap_or_default())
    }
}

/// How the row at `relative` shows a drag aimed at `folder` ("" the
/// project root, which washes the whole tree instead).
pub(super) fn drop_mark(folder: Option<&str>, relative: &str, is_folder: bool) -> DropMark {
    match folder {
        Some(folder) if !folder.is_empty() => {
            if is_folder && relative == folder {
                DropMark::Target
            } else if relative
                .strip_prefix(folder)
                .is_some_and(|rest| rest.starts_with('/'))
            {
                DropMark::Inside
            } else {
                DropMark::None
            }
        }
        _ => DropMark::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_lights_its_folder_and_the_rows_inside_it() {
        assert_eq!(
            drop_mark(Some("figures"), "figures", true),
            DropMark::Target
        );
        assert_eq!(
            drop_mark(Some("figures"), "figures/plot.png", false),
            DropMark::Inside
        );
        assert_eq!(
            drop_mark(Some("figures"), "figures/old", true),
            DropMark::Inside
        );
        // A look-alike folder, a file named like the folder, the root.
        assert_eq!(
            drop_mark(Some("figures"), "figures-old", true),
            DropMark::None
        );
        assert_eq!(drop_mark(Some("figures"), "figures", false), DropMark::None);
        assert_eq!(drop_mark(Some(""), "main.tex", false), DropMark::None);
        assert_eq!(drop_mark(None, "figures", true), DropMark::None);
    }
}
